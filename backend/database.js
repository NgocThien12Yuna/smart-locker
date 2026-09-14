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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN', 'RESIDENT')),
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

console.log('✅ SQLite database ready:', dbPath);
console.log(
  '💾 Persistent volume:',
  process.env.RAILWAY_VOLUME_MOUNT_PATH
    ? process.env.RAILWAY_VOLUME_MOUNT_PATH
    : 'LOCAL FILE',
);

module.exports = db;
