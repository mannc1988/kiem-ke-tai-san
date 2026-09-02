const mysql = require('mysql2/promise');
const cors = require('cors')({ origin: true });

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { 
        rejectUnauthorized: true, 
        ca: process.env.DB_CA_CERT 
    }
});

module.exports = async (req, res) => {
    return cors(req, res, async () => {
        const action = req.query.action || (req.body && req.body.action) || '';

        try {
            const connection = await pool.getConnection();

            // Tự động khởi tạo bảng nếu chưa có
            await connection.execute(`CREATE TABLE IF NOT EXISTS danh_sach_ts (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                room VARCHAR(100) NOT NULL
            )`);
            await connection.execute(`CREATE TABLE IF NOT EXISTS dot_kiem_ke (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                active TINYINT DEFAULT 0
            )`);
            await connection.execute(`CREATE TABLE IF NOT EXISTS lich_su_kk (
                id INT AUTO_INCREMENT PRIMARY KEY,
                dotId VARCHAR(50),
                tsId VARCHAR(50),
                tsName VARCHAR(255),
                nguoiKK VARCHAR(100),
                thoiGian VARCHAR(50),
                ghiChu TEXT
            )`);

            // Chèn dữ liệu mẫu nếu bảng trống
            const [rows] = await connection.execute("SELECT COUNT(*) as c FROM danh_sach_ts");
            if (rows[0].c === 0) {
                await connection.execute(`INSERT INTO danh_sach_ts (id, name, room) VALUES 
                    ('TS001', 'Máy tính Dell Latitude', 'Phòng Kế Toán'),
                    ('TS002', 'Máy in HP LaserJet', 'Phòng Hành Chính'),
                    ('TS003', 'Bàn làm việc gỗ', 'Phòng Giám Đốc')
                `);
            }
            const [dotRows] = await connection.execute("SELECT COUNT(*) as c FROM dot_kiem_ke");
            if (dotRows[0].c === 0) {
                await connection.execute("INSERT INTO dot_kiem_ke (id, name, active) VALUES ('DOT_01', 'Kiểm kê Quý 1/2026', 1)");
            }

            // 1. GET: Lấy thông tin chung (Đợt kiểm kê & cache danh mục tài sản)
            if (req.method === 'GET' && action === 'data') {
                const [danh_sach] = await connection.execute("SELECT * FROM danh_sach_ts");
                const [dot_kiem_ke] = await connection.execute("SELECT * FROM dot_kiem_ke");
                dot_kiem_ke.forEach(d => d.active = Boolean(d.active));
                const [lich_su] = await connection.execute("SELECT * FROM lich_su_kk ORDER BY id DESC");
                connection.release();
                return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
            }

            // 2. SERVER-SIDE: Bảng Danh Mục Tài Sản (Hỗ trợ Paging, Search, Order)
            if (req.method === 'GET' && action === 'server_assets') {
                const draw = parseInt(req.query.draw) || 1;
                const start = parseInt(req.query.start) || 0;
                const length = parseInt(req.query.length) || 10;
                const searchValue = req.query.search && req.query.search.value ? `%${req.query.search.value}%` : '%%';

                // Xử lý Sắp xếp (Order)
                const columnsMap = { 0: 'id', 1: 'id', 2: 'name', 3: 'room' };
                let orderBy = 'id';
                let orderDir = 'ASC';
                if (req.query.order && req.query.order[0]) {
                    const colIdx = req.query.order[0].column;
                    orderBy = columnsMap[colIdx] || 'id';
                    orderDir = req.query.order[0].dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                }

                // Tổng số bản ghi
                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM danh_sach_ts");
                const totalRecords = totalRows[0].total;

                // Tổng số bản ghi sau khi lọc tìm kiếm
                const [filteredRows] = await connection.execute(
                    "SELECT COUNT(*) as total FROM danh_sach_ts WHERE id LIKE ? OR name LIKE ? OR room LIKE ?",
                    [searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                // Lấy dữ liệu với phân trang, tìm kiếm và sắp xếp
                const query = `SELECT * FROM danh_sach_ts WHERE id LIKE ? OR name LIKE ? OR room LIKE ? ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, length, start]);

                connection.release();
                return res.json({
                    draw: draw,
                    recordsTotal: totalRecords,
                    recordsFiltered: filteredRecords,
                    data: data
                });
            }

            // 3. SERVER-SIDE: Bảng Lịch Sử Kiểm Kê (Hỗ trợ Paging, Search, Order)
            if (req.method === 'GET' && action === 'server_history') {
                const draw = parseInt(req.query.draw) || 1;
                const start = parseInt(req.query.start) || 0;
                const length = parseInt(req.query.length) || 10;
                const searchValue = req.query.search && req.query.search.value ? `%${req.query.search.value}%` : '%%';

                const historyColumnsMap = { 0: 'id', 1: 'tsId', 2: 'tsName', 3: 'nguoiKK', 4: 'thoiGian', 5: 'ghiChu' };
                let orderBy = 'id';
                let orderDir = 'DESC';
                if (req.query.order && req.query.order[0]) {
                    const colIdx = req.query.order[0].column;
                    orderBy = historyColumnsMap[colIdx] || 'id';
                    orderDir = req.query.order[0].dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
                }

                const [totalRows] = await connection.execute("SELECT COUNT(*) as total FROM lich_su_kk");
                const totalRecords = totalRows[0].total;

                const [filteredRows] = await connection.execute(
                    "SELECT COUNT(*) as total FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ?",
                    [searchValue, searchValue, searchValue, searchValue]
                );
                const filteredRecords = filteredRows[0].total;

                const query = `SELECT * FROM lich_su_kk WHERE tsId LIKE ? OR tsName LIKE ? OR nguoiKK LIKE ? OR ghiChu LIKE ? ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`;
                const [data] = await connection.execute(query, [searchValue, searchValue, searchValue, searchValue, length, start]);

                connection.release();
                return res.json({
                    draw: draw,
                    recordsTotal: totalRecords,
                    recordsFiltered: filteredRecords,
                    data: data
                });
            }

            // Các hành động POST (history, save_asset, delete_asset, delete_history) giữ nguyên như cũ
            if (req.method === 'POST' && action === 'history') {
                const { dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu } = req.body;
                const [existing] = await connection.execute("SELECT * FROM lich_su_kk WHERE dotId = ? AND tsId = ?", [dotId, tsId]);
                if (existing.length > 0) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Tài sản đã được kiểm kê trước đó trong đợt này!' });
                }
                await connection.execute("INSERT INTO lich_su_kk (dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu) VALUES (?, ?, ?, ?, ?, ?)", [dotId, tsId, tsName, nguoiKK, thoiGian, ghiChu || 'Quét QR Aiven']);
                connection.release();
                return res.json({ success: true });
            }

            if (req.method === 'POST' && action === 'save_asset') {
                const { id, name, room } = req.body;
                if (!id || !name || !room) {
                    connection.release();
                    return res.status(400).json({ success: false, error: 'Vui lòng điền đầy đủ thông tin!' });
                }
                await connection.execute(`INSERT INTO danh_sach_ts (id, name, room) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), room = VALUES(room)`, [id, name, room]);
                connection.release();
                return res.json({ success: true, message: 'Lưu tài sản thành công!' });
            }

            if (req.method === 'POST' && action === 'delete_asset') {
                const { id } = req.body;
                await connection.execute("DELETE FROM danh_sach_ts WHERE id = ?", [id]);
                connection.release();
                return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
            }

            if (req.method === 'POST' && action === 'delete_history') {
                const { id } = req.body;
                await connection.execute("DELETE FROM lich_su_kk WHERE id = ?", [id]);
                connection.release();
                return res.json({ success: true, message: 'Đã xóa lịch sử thành công!' });
            }

            connection.release();
            return res.status(400).json({ success: false, error: 'Invalid action or method' });

        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    });
};
