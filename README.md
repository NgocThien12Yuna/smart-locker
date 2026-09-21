# 🔐 SmartLocker

SmartLocker là ứng dụng mô phỏng hệ thống **tủ nhận hàng thông minh** dành cho chung cư/ký túc xá, gồm 3 nhóm người dùng:

- **Shipper**: đăng nhập, chụp bill/nhập số điện thoại người nhận và tạo đơn giao hàng.
- **Cư dân**: nhận thông báo Firebase, xem OTP, mở tủ và nhận hàng.
- **Admin**: theo dõi trạng thái tủ, lịch sử giao dịch và mở tủ khẩn cấp.

## 1. Kiến trúc hệ thống

```text
React Native App
       |
       v
Railway Backend
(Node.js + Express)
       |
       +--> SQLite + Railway Volume
       |
       +--> Firebase Cloud Messaging
       |
       +--> JWT Authentication
```

Phần AI chạy trực tiếp trên ứng dụng Android bằng **PP-OCRv6 Small + ONNX Runtime**:

```text
Camera / ảnh bill
        |
        v
PP-OCRv6 Small Text Detector
(Model 1 - ONNX)
        |
        v
Phát hiện các vùng văn bản trên toàn bill
        |
        v
PP-OCRv6 Small Text Recognizer
(Model 2 - ONNX)
        |
        v
OCR toàn bộ nội dung bill
        |
        v
FAST-SAFE Receiver Selector
- ưu tiên vùng Đến / Receiver / Người nhận
- loại vùng Từ / Sender / Hotline / mã vận đơn
- chuẩn hóa +84 -> 0
        |
        v
SĐT người nhận
```

## 2. Công nghệ sử dụng

### Mobile App
- React Native
- TypeScript
- React Navigation
- AsyncStorage
- React Native Vision Camera
- React Native Firebase Messaging
- ONNX Runtime React Native
- React Native FS
- `jpeg-js`
- React Native Image Resizer

### Backend
- Node.js
- Express.js
- SQLite (`better-sqlite3`)
- JWT
- bcryptjs
- Firebase Admin SDK

### Cloud
- Railway: chạy backend và lưu SQLite bằng Volume
- Firebase Cloud Messaging: gửi thông báo đến cư dân
- GitHub: quản lý source code và tự động deploy Railway

## 3. Chức năng chính

### 🚚 Shipper
- Đăng ký bằng số điện thoại + mật khẩu.
- Yêu cầu **mã giới thiệu Shipper** khi đăng ký.
- Đăng nhập trước khi sử dụng chức năng giao hàng.
- Chụp ảnh bill bằng camera.
- AI nhận diện số điện thoại người nhận.
- Có thể sửa số điện thoại thủ công nếu AI nhận sai.
- Backend tự chọn tủ trống phù hợp.
- Tạo đơn và gửi thông báo Firebase đến cư dân.

### 🏠 Cư dân
- Đăng ký / đăng nhập bằng số điện thoại.
- Liên kết thiết bị với Firebase Cloud Messaging.
- Nhận notification khi có hàng mới.
- Bấm notification để mở đúng đơn hàng.
- OTP được hiển thị tự động trong ứng dụng.
- OTP có thời gian hết hạn.
- Có thể cấp lại OTP khi hết hạn.
- OTP chỉ dùng một lần.
- Sau khi mở tủ thành công, đơn rời khỏi danh sách chờ lấy.

### 👨‍💼 Admin
- Đăng ký bằng mã Admin.
- Theo dõi trạng thái toàn bộ tủ.
- Xem tủ đang trống / đang có hàng.
- Xem lịch sử gửi hàng, nhận hàng và mở khẩn cấp.
- Mở tủ khẩn cấp khi cần.

## 4. Luồng hoạt động

```text
Shipper đăng nhập
        |
        v
Chụp bill / nhập SĐT
        |
        v
Backend kiểm tra cư dân
        |
        v
Tự chọn tủ trống
        |
        v
Tạo đơn + OTP
        |
        v
Firebase gửi Notification
        |
        v
Cư dân mở app
        |
        v
OTP tự hiển thị
        |
        v
Cư dân bấm MỞ TỦ
        |
        v
Backend xác minh OTP
        |
        v
Đơn chuyển sang PICKED_UP
        |
        v
Admin History được cập nhật
```

## 5. Cấu trúc project

```text
SmartLockerApp/
├── android/
│   └── app/
│       └── src/
│           └── main/
│               └── assets/
│                   └── smartlocker/
│                       ├── model1_detector.onnx
│                       ├── model2_recognizer.onnx
│                       ├── ppocr_keys.txt
│                       ├── model1_detector_inference.yml
│                       ├── model2_recognizer_inference.yml
│                       └── manifest.json
├── backend/
│   ├── server.js
│   ├── database.js
│   ├── package.json
│   ├── .env.example
│   └── smartlocker.db
├── src/
│   ├── ai/
│   │   └── smartlockerOcr.ts
│   ├── config/api.ts
│   ├── context/AuthContext.tsx
│   ├── navigation/AppNavigator.tsx
│   ├── services/authApi.ts
│   └── screens/
│       ├── HomeScreen.tsx
│       ├── LoginScreen.tsx
│       ├── RegisterScreen.tsx
│       ├── ShipperScreen.tsx
│       ├── ResidentScreen.tsx
│       ├── AdminScreen.tsx
│       └── HistoryScreen.tsx
├── App.tsx
└── package.json
```

> `node_modules`, file `.env`, Firebase service-account key và database thật không nên commit lên GitHub.

## 6. Cấu hình Backend

Tạo file:

```text
backend/.env
```

Ví dụ:

```env
PORT=3000
JWT_SECRET=YOUR_SECRET_KEY
ADMIN_REGISTER_CODE=YOUR_ADMIN_CODE
SHIPPER_REGISTER_CODE=123456
OTP_TTL_MINUTES=15
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
```

Khi chạy trên Railway, nên cấu hình các giá trị trên bằng **Railway Variables** thay vì commit file `.env`.

## Yêu cầu môi trường

Trước khi chạy project, cần cài đặt:

- Node.js
- npm
- Android Studio
- Android SDK
- JDK
- Android Emulator hoặc thiết bị Android thật

Tham khảo hướng dẫn thiết lập môi trường React Native:

```text
https://reactnative.dev/docs/set-up-your-environment
```

Kiểm tra môi trường:

```bash
node --version
npm --version
adb devices
```

## 7. Chạy Backend Local

```bash
cd backend
npm install
npm start
```

Kiểm tra:

```text
http://localhost:3000/health
```

Nếu backend hoạt động bình thường sẽ trả về JSON có:

```json
{
  "ok": true
}
```

## 8. Chạy ứng dụng Android

Cài package:

```bash
npm install
```

Khởi động Metro:

```bash
npx react-native start --reset-cache
```

Mở terminal khác:

```bash
npx react-native run-android
```

## 9. API Backend

Một số endpoint chính:

```text
POST /auth/register
POST /auth/login
GET  /auth/me
POST /devices/register
POST /packages
GET  /packages/my
POST /packages/:packageId/otp/refresh
POST /packages/:packageId/redeem
GET  /admin/overview
GET  /admin/history
POST /admin/packages/:packageId/force-open
GET /health
```

### Bảo vệ API
- `/packages` chỉ cho tài khoản `SHIPPER`.
- `/packages/my` và `/redeem` chỉ cho `RESIDENT`.
- `/admin/*` chỉ cho `ADMIN`.
- Request được xác thực bằng JWT.

## 10. Railway + GitHub

Backend được deploy từ GitHub lên Railway.

Khi sửa backend:

```bash
git add .
git commit -m "Update SmartLocker"
git push
```

Railway sẽ tự động build và deploy lại phiên bản mới.

Các biến bí mật cần đặt trong:

```text
Railway
→ smart-locker service
→ Variables
```

Ví dụ:

```text
JWT_SECRET
ADMIN_REGISTER_CODE
SHIPPER_REGISTER_CODE
FIREBASE_SERVICE_ACCOUNT_JSON
OTP_TTL_MINUTES
```

## 11. Database

SmartLocker hiện sử dụng:

```text
SQLite
+
Railway Persistent Volume
```

Các bảng chính:

```text
users
devices
packages
activity_logs
```

Trạng thái đơn:

```text
READY
PICKED_UP
CANCELLED
```

## 12. Firebase Notification

Firebase Cloud Messaging được dùng để thông báo cho cư dân khi Shipper tạo đơn mới.

```text
Backend Railway
      |
      v
Firebase Admin SDK
      |
      v
Firebase Cloud Messaging
      |
      v
Điện thoại cư dân
```

Khi app ở background hoặc đóng, notification vẫn có thể xuất hiện trên thanh trạng thái.

## 13. AI nhận diện số điện thoại

Phiên bản hiện tại không còn dùng pipeline YOLO + CRNN/TensorFlow Lite cũ.  
AI được chuyển sang **PP-OCRv6 Small chạy bằng ONNX Runtime ngay trên Android**.

### 13.1. Hai model AI

#### Model 1 - PP-OCRv6 Small Text Detector

Nhiệm vụ:
- Nhận toàn bộ ảnh bill từ Camera.
- Phát hiện các vùng có văn bản trên bill.
- Không chỉ tìm riêng vùng số điện thoại.
- Cho phép dùng chung với nhiều mẫu bill khác nhau như Shopee, Lazada, TikTok Shop, J&T, Ninja Van,...

File model:

```text
android/app/src/main/assets/smartlocker/model1_detector.onnx
```

Đầu vào của model có dạng:

```text
N x 3 x H x W
```

Ảnh được resize, normalize và đưa về định dạng tensor trước khi chạy ONNX Runtime.

---

#### Model 2 - PP-OCRv6 Small Text Recognizer

Nhiệm vụ:
- Nhận từng vùng chữ do Model 1 phát hiện.
- Đọc nội dung văn bản trên từng dòng.
- Hỗ trợ cả chữ, số và ký tự để có thể đọc toàn bộ bill.

File model:

```text
android/app/src/main/assets/smartlocker/model2_recognizer.onnx
```

Dictionary OCR:

```text
android/app/src/main/assets/smartlocker/ppocr_keys.txt
```

Input recognizer hiện được chuẩn hóa theo dạng:

```text
N x 3 x 48 x 320
```

Kết quả recognizer được giải mã theo cơ chế CTC để tạo chuỗi văn bản.

### 13.2. Chuyển model sang ONNX

Hai model PaddleOCR được xuất sang dạng inference và chuyển sang ONNX bằng **Paddle2ONNX**.

Pipeline chuẩn bị model:

```text
PP-OCRv6 Small
      |
      v
Paddle Inference Model
      |
      v
Paddle2ONNX
      |
      v
model1_detector.onnx
model2_recognizer.onnx
      |
      v
ONNX Runtime React Native
      |
      v
Android App
```

Sau khi chuyển đổi, model được kiểm tra bằng `onnx.checker` trước khi đóng gói vào ứng dụng.

### 13.3. Pipeline nhận diện trên ShipperScreen

```text
Shipper chụp bill
        |
        v
Resize ảnh làm việc
        |
        v
Model 1 - Text Detector
        |
        v
Danh sách text boxes
        |
        v
Model 2 - Text Recognizer
        |
        v
Danh sách text OCR
        |
        v
Receiver Selector
        |
        v
Kiểm tra SĐT Việt Nam
        |
        v
Hiển thị SĐT người nhận
```

Ứng dụng không lấy ngay chuỗi số đầu tiên tìm thấy.  
Sau OCR, hệ thống tiếp tục xác định **SĐT của người nhận** dựa trên ngữ cảnh của bill.

### 13.4. FAST-SAFE Receiver Selector

Bill giao hàng thường chứa nhiều chuỗi số khác nhau:
- mã vận đơn;
- mã đơn hàng;
- hotline;
- SĐT người gửi;
- SĐT người nhận.

Vì vậy, hệ thống dùng lớp chọn kết quả **FAST-SAFE Receiver Selector**.

Các từ khóa ưu tiên:

```text
Đến
Người nhận
Receiver
Recipient
Consignee
Giao đến
```

Các vùng bị giảm điểm hoặc loại:

```text
Từ
Người gửi
Sender
Hotline
CSKH
Tổng đài
Mã vận đơn
Mã đơn hàng
Tracking
Order ID
```

Ví dụ:

```text
Mã vận đơn: SPXVN0352984121
```

không được phép biến thành:

```text
0352984121
```

vì đây là chuỗi số nằm bên trong mã vận đơn, không phải SĐT độc lập.

Một SĐT hợp lệ phải thỏa điều kiện số di động Việt Nam:

```text
0[35789]xxxxxxxx
```

hoặc được chuẩn hóa từ:

```text
+84xxxxxxxxx
```

sang:

```text
0xxxxxxxxx
```

### 13.5. Tối ưu tốc độ

Để giảm thời gian xử lý trên điện thoại, pipeline hiện có các tối ưu:

- Chạy góc `0°` trước.
- Chỉ thử thêm `90°`, `270°`, `180°` khi chưa tìm được kết quả tin cậy.
- OCR nhiều text box theo batch thay vì gọi recognizer từng box riêng lẻ.
- Early-stop khi đã xác định được SĐT người nhận đủ chắc chắn.
- Ưu tiên execution provider XNNPACK trên Android, tự fallback CPU nếu cần.
- Resize ảnh trước khi inference để giảm lượng dữ liệu xử lý.

Nhờ vậy hệ thống vẫn hỗ trợ ảnh bị xoay nhưng không bắt buộc phải chạy cả 4 góc trong mọi trường hợp.

### 13.6. Xử lý nhiều góc chụp

Pipeline có thể kiểm tra:

```text
0°
90°
180°
270°
```

Điều này giúp AI vẫn có khả năng đọc bill khi Shipper cầm điện thoại hoặc bill bị xoay.

Trong trường hợp ảnh chụp đúng chiều và đã tìm được SĐT người nhận ở `0°`, hệ thống dừng sớm để giảm thời gian xử lý.

### 13.7. Tích hợp vào React Native

Module AI được tách riêng tại:

```text
src/ai/smartlockerOcr.ts
```

`ShipperScreen.tsx` chịu trách nhiệm:
- chụp bill;
- gọi module AI;
- hiển thị SĐT nhận diện;
- cho phép Shipper sửa SĐT thủ công;
- gửi SĐT đã xác nhận lên backend.

Model được copy từ Android assets ra cache trước khi tạo ONNX `InferenceSession`.

Pipeline chạy hoàn toàn trên thiết bị Android, không cần gửi ảnh bill lên Railway.

### 13.8. Kết quả thực tế

Qua kiểm thử bill có cả SĐT người gửi và người nhận, hệ thống có thể OCR được nhiều dòng trên bill và ưu tiên đúng SĐT nằm trong vùng người nhận.

Ví dụ bill có:

```text
Từ:
SĐT: 0909123456

Đến:
SĐT: 0327622447
```

kết quả cuối cùng được chọn:

```text
0327622447
```

Nếu AI chưa tìm được số phù hợp, Shipper vẫn có thể nhập hoặc sửa SĐT thủ công trước khi xác nhận gửi hàng.

## 14. Trạng thái phần cứng

Hiện tại chức năng mở khóa đang chạy ở:

```text
SOFTWARE MODE
```

Backend mô phỏng việc mở khóa.

Hướng phát triển tiếp theo:

```text
Backend
   |
HTTP / MQTT
   |
ESP32
   |
Relay
   |
Khóa điện
```

Chỉ khi ESP32 phản hồi mở khóa thành công thì backend mới cập nhật đơn thành `PICKED_UP`.

## 15. Lưu ý bảo mật

Không commit các file sau lên GitHub:
file

```text
.env
firebase-service-account.json
smartlocker.db
smartlocker.db-shm
smartlocker.db-wal
node_modules/
android/.cxx/
android/build/
android/app/build/
```

Các secret như `JWT_SECRET`, `ADMIN_REGISTER_CODE`, `SHIPPER_REGISTER_CODE` và Firebase private key phải lưu trong Railway Variables hoặc file `.env` local.

## 16. Mục tiêu đề tài

SmartLocker hướng đến mô hình giao nhận hàng tự động, trong đó:
- Shipper được xác thực trước khi tạo đơn.
- AI PP-OCRv6 + ONNX hỗ trợ OCR toàn bill và tự chọn đúng số điện thoại người nhận.
- Backend tự động cấp tủ.
- Cư dân nhận thông báo và OTP trên điện thoại.
- Admin giám sát toàn bộ trạng thái hệ thống.
- Có khả năng mở rộng sang ESP32 và khóa điện thực tế.

## Khắc phục sự cố

### Metro không kết nối được

Chạy lại Metro:

```bash
npx react-native start --reset-cache
```

Sau đó mở terminal khác:

```bash
npx react-native run-android
```

### Emulator báo `Unable to load script`

Kiểm tra Metro có đang chạy ở:

```text
http://localhost:8081
```

Nếu Metro chưa chạy, khởi động lại bằng:

```bash
npx react-native start --reset-cache
```

### Lỗi cache Android / CMake

Có thể xóa các thư mục build tạm:

```powershell
Remove-Item -Recurse -Force .\android\.cxx -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\android\app\.cxx -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .\node_modules\react-native-worklets-core\android\.cxx -ErrorAction SilentlyContinue
```

Sau đó chạy lại Metro và app.

### Backend không kết nối được

Kiểm tra endpoint:

```text
GET /health
```

và xác nhận `API_BASE_URL` đang trỏ đúng backend Railway.

Nếu Railway đang deploy từ GitHub, kiểm tra deployment mới nhất đã ở trạng thái `Online` / `Active`.

## 17. Tác giả

Đồ án SmartLocker phục vụ mục đích học tập và nghiên cứu.
