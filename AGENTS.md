# Agent Instructions — Impact Graph

## Quy tắc bắt buộc khi làm việc với API

Mỗi khi user yêu cầu **fix / update / delete / refactor** bất kỳ API, endpoint, hoặc handler function nào, bạn **PHẢI** thực hiện đúng thứ tự sau trước khi viết bất kỳ dòng code nào:

### Bước 1 — Kiểm tra graph sẵn sàng
```
Gọi MCP tool: graph_status
```
- Nếu `nodes = 0` → thông báo user chạy "Impact Graph: Build Impact Graph" trước, dừng lại.
- Nếu `nodes > 0` → tiếp tục bước 2.

### Bước 2 — Phân tích impact
```
Gọi MCP tool: query_impact
Input: tên handler function HOẶC API path liên quan đến yêu cầu của user
```
Kết quả sẽ trả về:
- `apis` — danh sách API endpoints bị ảnh hưởng
- `handlers` — function xử lý các API đó (file + line)
- `callers` — các service/task đang gọi API này
- `tests` — các file test cần được cập nhật

### Bước 3 — Thực hiện thay đổi
Dựa vào kết quả `query_impact`:
1. Sửa đúng file handler được chỉ ra
2. Cập nhật **tất cả** test files có trong danh sách `tests`
3. Kiểm tra `callers` — nếu có service khác đang gọi API này, cảnh báo user về khả năng breaking change

---

## Ví dụ trigger (luôn áp dụng quy tắc trên)

| User nói | Hành động bắt buộc |
|---|---|
| "Fix bug trong API tạo user" | `query_impact("create_user")` |
| "Đổi response format của /order/create" | `query_impact("/order/create")` |
| "Xóa endpoint GET /product/:id" | `query_impact("GET /product/:id")` |
| "Refactor hàm update_payment" | `query_impact("update_payment")` |
| "Thêm field vào API login" | `query_impact("login")` |
| "Sửa validation trong POST /user" | `query_impact("POST /user")` |

---

## Quy tắc bổ sung

- **Không được bỏ qua** bước query impact dù yêu cầu có vẻ nhỏ — một thay đổi nhỏ trong handler có thể làm fail nhiều test.
- Nếu `query_impact` trả về `tests: []` (không có test), hãy thông báo user: _"Không tìm thấy test liên quan — có thể graph chưa được build sau lần thay đổi cuối."_
- Nếu user nói "chỉ sửa nhanh thôi, không cần check" → vẫn phải gọi `query_impact` nhưng có thể bỏ qua bước update test nếu user xác nhận.
- Sau khi sửa xong, nhắc user chạy `Impact Graph: Refresh Changed` để cập nhật graph.

---

## MCP Tools có sẵn

| Tool | Mô tả |
|---|---|
| `graph_status` | Kiểm tra graph đã build chưa (projects/nodes/edges count) |
| `query_impact` | Full impact: file, handler, callers, tests cho 1 API |
| `find_tests` | Chỉ trả về danh sách tests (nhẹ hơn query_impact) |
| `list_apis` | Liệt kê tất cả APIs trong workspace |
