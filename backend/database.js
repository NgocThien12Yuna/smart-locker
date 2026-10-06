const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ======================================================
// DATABASE PATH
// ======================================================
//
// LOCAL:
//   backend/smartlocker.db
//
// RAILWAY + VOLUME:
//   Railway tự cấp RAILWAY_VOLUME_MOUNT_PATH.
//   Nếu volume mount ở /data thì DB nằm ở:
//   /data/smartlocker.db
//
// Có thể override thủ công bằng DB_PATH.

const volumeMountPath =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.DB_DIRECTORY ||
  '';

const defaultDbPath = volumeMountPath
  ? path.join(volumeMountPath, 'smartlocker.db')
  : path.join(__dirname, 'smartlocker.db');

const dbPath =
  process.env.DB_PATH ||
  defaultDbPath;

fs.mkdirSync(
  path.dirname(dbPath),
  {
    recursive: true,
  },
);

const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ======================================================
// USERS
// ======================================================
//
// DB cũ chỉ cho ADMIN/RESIDENT.
// Migration dưới đây thêm SHIPPER nhưng giữ nguyên tài khoản cũ.

const usersTable = db
  .prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'users'
  `)
  .get();

const usersNeedShipperMigration =
  usersTable?.sql &&
  !/SHIPPER/i.test(usersTable.sql);

if (usersNeedShipperMigration) {
  console.log('♻️ Migrating users table: add SHIPPER role...');

  db.pragma('foreign_keys = OFF');

  const migrateUsers = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK(role IN ('ADMIN', 'RESIDENT', 'SHIPPER')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(phone, role)
      );

      INSERT INTO users_new (
        id, phone, password_hash, role, created_at
      )
      SELECT
        id, phone, password_hash, role, created_at
      FROM users;

      DROP TABLE users;

      ALTER TABLE users_new
      RENAME TO users;
    `);
  });

  migrateUsers();
  db.pragma('foreign_keys = ON');

  console.log('✅ users migration complete: SHIPPER enabled.');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL
      CHECK(role IN ('ADMIN', 'RESIDENT', 'SHIPPER')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(phone, role)
  );
`);

// ======================================================
// DEVICES
// ======================================================

const devicesTable = db
  .prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'devices'
  `)
  .get();

if (
  devicesTable?.sql &&
  !/UNIQUE\s*\(\s*user_id\s*,\s*fcm_token\s*\)/i.test(
    devicesTable.sql,
  )
) {
  console.log('♻️ Migrating devices table...');

  db.exec(`
    DROP TABLE IF EXISTS devices;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fcm_token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, fcm_token)
  );
`);

// ======================================================
// PACKAGES
// ======================================================
//
// pickup_token / pickup_otp được giữ lại để tương thích DB cũ.
// Bản mới dùng:
//   pickup_otp_hash
//   pickup_otp_enc
//   pickup_otp_iv
//   pickup_otp_tag
//   otp_expires_at
//
// OTP không còn được lưu plaintext cho các đơn mới.

db.exec(`
  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    public_id TEXT NOT NULL UNIQUE,

    receiver_user_id INTEGER NOT NULL,
    receiver_phone TEXT NOT NULL,

    locker TEXT NOT NULL,
    size TEXT NOT NULL DEFAULT 'M',
    sender TEXT NOT NULL DEFAULT 'Shipper',

    pickup_token TEXT NOT NULL UNIQUE,
    pickup_otp TEXT,

    pickup_otp_hash TEXT,
    pickup_otp_enc TEXT,
    pickup_otp_iv TEXT,
    pickup_otp_tag TEXT,
    otp_expires_at TEXT,

    status TEXT NOT NULL DEFAULT 'READY'
      CHECK(status IN ('READY', 'PICKED_UP', 'CANCELLED')),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    picked_up_at TEXT,

    FOREIGN KEY(receiver_user_id) REFERENCES users(id)
  );
`);

const packageColumns = db
  .prepare(`PRAGMA table_info(packages)`)
  .all();

const ensurePackageColumn = (name, sqlType) => {
  const exists = packageColumns.some(
    column => column.name === name,
  );

  if (!exists) {
    console.log(`♻️ Adding ${name} column to packages...`);

    db.exec(`
      ALTER TABLE packages
      ADD COLUMN ${name} ${sqlType};
    `);
  }
};

ensurePackageColumn('pickup_otp', 'TEXT');
ensurePackageColumn('pickup_otp_hash', 'TEXT');
ensurePackageColumn('pickup_otp_enc', 'TEXT');
ensurePackageColumn('pickup_otp_iv', 'TEXT');
ensurePackageColumn('pickup_otp_tag', 'TEXT');
ensurePackageColumn('otp_expires_at', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_packages_receiver
  ON packages(receiver_user_id, status);

  CREATE INDEX IF NOT EXISTS idx_packages_phone
  ON packages(receiver_phone);

  CREATE INDEX IF NOT EXISTS idx_packages_locker_status
  ON packages(locker, status);

  CREATE INDEX IF NOT EXISTS idx_packages_pickup_token
  ON packages(pickup_token);
`);

// ======================================================
// ACTIVITY LOGS / HISTORY
// ======================================================

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,

    action TEXT NOT NULL
      CHECK(action IN ('GỬI HÀNG', 'NHẬN HÀNG', 'MỞ KHẨN CẤP')),

    package_public_id TEXT,
    phone TEXT NOT NULL,
    locker TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
  ON activity_logs(created_at DESC);
`);

// Backfill lịch sử cho dữ liệu đã tồn tại từ trước.
db.exec(`
  INSERT OR IGNORE INTO activity_logs (
    event_key,
    action,
    package_public_id,
    phone,
    locker,
    created_at
  )
  SELECT
    'PACKAGE_CREATED:' || public_id,
    'GỬI HÀNG',
    public_id,
    receiver_phone,
    locker,
    created_at
  FROM packages;
`);

db.exec(`
  INSERT OR IGNORE INTO activity_logs (
    event_key,
    action,
    package_public_id,
    phone,
    locker,
    created_at
  )
  SELECT
    'PACKAGE_PICKED_UP:' || public_id,
    'NHẬN HÀNG',
    public_id,
    receiver_phone,
    locker,
    picked_up_at
  FROM packages
  WHERE
    status = 'PICKED_UP'
    AND picked_up_at IS NOT NULL;
`);


// ======================================================
// HARDWARE COMMANDS - ESP32
// ======================================================
//
// Luồng mới:
// OPEN  -> ESP32 bật relay và GIỮ ON.
// CLOSE -> ESP32 tắt relay khi người dùng bấm OK.
//
// package vẫn READY sau OPEN.
// Chỉ sau khi CLOSE được ESP32 ACK thành công mới chuyển PICKED_UP.
//
// Có migration tự động từ schema cũ chỉ cho OPEN
// sang schema mới hỗ trợ OPEN + CLOSE.

const hardwareCommandsTable = db
  .prepare(`
    SELECT sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'hardware_commands'
  `)
  .get();

const hardwareCommandsNeedCloseMigration =
  hardwareCommandsTable?.sql &&
  !/\bCLOSE\b/i.test(
    hardwareCommandsTable.sql,
  );

if (
  hardwareCommandsNeedCloseMigration
) {
  console.log(
    '♻️ Migrating hardware_commands: OPEN -> OPEN/CLOSE...',
  );

  db.pragma(
    'foreign_keys = OFF',
  );

  try {
    const migrateHardwareCommands =
      db.transaction(() => {
        db.exec(`
          ALTER TABLE hardware_commands
          RENAME TO hardware_commands_old;
        `);

        db.exec(`
          CREATE TABLE hardware_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            package_public_id TEXT NOT NULL,

            action TEXT NOT NULL DEFAULT 'OPEN'
              CHECK(action IN ('OPEN', 'CLOSE')),

            locker TEXT NOT NULL,

            requested_by TEXT NOT NULL
              CHECK(requested_by IN ('RESIDENT', 'ADMIN')),

            requested_by_user_id INTEGER,

            status TEXT NOT NULL DEFAULT 'PENDING'
              CHECK(status IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),

            device_id TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,

            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            claimed_at TEXT,
            completed_at TEXT,

            error_message TEXT
          );
        `);

        db.exec(`
          INSERT INTO hardware_commands (
            id,
            package_public_id,
            action,
            locker,
            requested_by,
            requested_by_user_id,
            status,
            device_id,
            attempts,
            created_at,
            claimed_at,
            completed_at,
            error_message
          )
          SELECT
            id,
            package_public_id,
            action,
            locker,
            requested_by,
            requested_by_user_id,
            status,
            device_id,
            attempts,
            created_at,
            claimed_at,
            completed_at,
            error_message
          FROM hardware_commands_old;
        `);

        db.exec(`
          DROP TABLE hardware_commands_old;
        `);
      });

    migrateHardwareCommands();

    console.log(
      '✅ hardware_commands migration complete: OPEN + CLOSE.',
    );
  } finally {
    db.pragma(
      'foreign_keys = ON',
    );
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS hardware_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    package_public_id TEXT NOT NULL,

    action TEXT NOT NULL DEFAULT 'OPEN'
      CHECK(action IN ('OPEN', 'CLOSE')),

    locker TEXT NOT NULL,

    requested_by TEXT NOT NULL
      CHECK(requested_by IN ('RESIDENT', 'ADMIN')),

    requested_by_user_id INTEGER,

    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED')),

    device_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    claimed_at TEXT,
    completed_at TEXT,

    error_message TEXT
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_hardware_commands_status
  ON hardware_commands(status, id);

  CREATE INDEX IF NOT EXISTS idx_hardware_commands_package
  ON hardware_commands(package_public_id, id DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_hardware_commands_one_active_per_package
  ON hardware_commands(package_public_id)
  WHERE status IN ('PENDING', 'CLAIMED');
`);

console.log('✅ SQLite database ready:', dbPath);
console.log(
  '💾 Persistent volume:',
  process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? process.env.RAILWAY_VOLUME_MOUNT_PATH
    : 'LOCAL FILE',
);

module.exports = db;
