const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');
const fetch = require('node-fetch');

// Cấu hình khóa bí mật AES
const SECRET_KEY = process.env.SECRET_KEY || 'ManNC@2026_SecureKeyAivenMySQL!';

// Cấu hình kết nối Aiven MySQL
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { 
        rejectUnauthorized: true, 
        ca: process.env.DB_CA_CERT 
    }
};

// ==========================================
// HÀM HELPER MÃ HÓA & GIẢI MÃ DỮ LIỆU AES
// ==========================================

function encryptData(plainText) {
    if (plainText === undefined || plainText === null || plainText === '') return '';
    return CryptoJS.AES.encrypt(plainText.toString(), SECRET_KEY).toString();
}

function decryptData(cipherText) {
    if (!cipherText) return '';
    try {
        const bytes = CryptoJS.AES.decrypt(cipherText.toString(), SECRET_KEY);
        const originalText = bytes.toString(CryptoJS.enc.Utf8);
        return originalText || cipherText; 
    } catch (e) {
        return cipherText; 
    }
}

// Chuẩn hóa giá trị active về dạng số thuần (1 hoặc 0)
function getRawActiveNumber(activeInput) {
    if (activeInput === undefined || activeInput === null || activeInput === '') return 1;
    const decrypted = decryptData(activeInput).toString().trim();
    const val = Number(decrypted);
    return isNaN(val) ? 1 : (val !== 0 ? 1 : 0);
}

// Helper ghi Audit Log vào CSDL
async function logAssetAction(connection, { ts_id, action_type, performed_by, old_data, new_data, note }) {
    try {
        const sql = `
            INSERT INTO asset_audit_logs (ts_id, action_type, performed_by, old_data, new_data, note)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        const encUser = performed_by ? encryptData(performed_by) : '';
        const encNote = note ? encryptData(note) : '';
        
        await connection.execute(sql, [
            ts_id,
            action_type, // 'CREATE', 'UPDATE', 'AUDIT', 'DELETE'
            encUser,
            old_data ? JSON.stringify(old_data) : null,
            new_data ? JSON.stringify(new_data) : null,
            encNote
        ]);
    } catch (err) {
        console.error('Lỗi khi ghi Audit Log:', err);
    }
}

// ==========================================
// EXPORT HANDLER VERCEL SERVERLESS
// ==========================================

module.exports = async (req, res) => {
    // Thiết lập Header CORS
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Lấy action từ Query (GET) hoặc Body (POST)
    const action = req.query.action || req.body.action;
    let connection;

    try {
        if (!action) {
            return res.status(400).json({ success: false, error: 'Thiếu tham số action yêu cầu' });
        }

        connection = await mysql.createConnection(dbConfig);

        // ----------------------------------------------------
        // 1. LẤY DỮ LIỆU BAN ĐẦU
        // ----------------------------------------------------
        if (action === 'data') {
            const dot_id = req.query.dot_id || req.body.dot_id;

            const [danh_sach] = await connection.execute('SELECT * FROM danh_sach_tai_san ORDER BY ma_tai_san DESC');
            const [dotRows] = await connection.execute('SELECT * FROM dot_kiem_ke ORDER BY id DESC');

            let sqlLichSu = 'SELECT * FROM lich_su_kk';
            let paramsLichSu = [];

            if (dot_id && dot_id.toString().trim() !== '') {
                sqlLichSu += ' WHERE dot_id = ? ORDER BY id DESC';
                paramsLichSu.push(dot_id.toString().trim());
            } else {
                sqlLichSu += ' ORDER BY id DESC';
            }

            const [lich_su] = await connection.execute(sqlLichSu, paramsLichSu);

            const dot_kiem_ke = dotRows.map(d => {
                const decActive = decryptData(d.active);
                const rawActiveNum = !isNaN(decActive) && decActive !== '' ? Number(decActive) : Number(d.active);
                return {
                    ...d,
                    name: decryptData(d.name),
                    active: isNaN(rawActiveNum) ? 1 : rawActiveNum
                };
            });

            return res.json({ success: true, danh_sach, dot_kiem_ke, lich_su });
        }

        // ----------------------------------------------------
        // 1.1 - 1.4 QUẢN LÝ ĐỢT KIỂM KÊ
        // ----------------------------------------------------
        if (action === 'add_dot' && req.method === 'POST') {
            const { name, active } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'Tên đợt kiểm kê không được để trống!' });
            }

            const rawName = decryptData(name).trim();
            const encName = encryptData(rawName);
            const rawActiveNum = getRawActiveNumber(active);
            const encActive = encryptData(rawActiveNum.toString());

            const [result] = await connection.execute(
                'INSERT INTO dot_kiem_ke (name, active) VALUES (?, ?)',
                [encName, encActive]
            );

            return res.json({ 
                success: true, 
                id: result.insertId, 
                name: rawName,
                active: rawActiveNum,
                message: 'Đã tạo đợt kiểm kê mới thành công!' 
            });
        }

        if (action === 'update_dot' && req.method === 'POST') {
            const { id, name, active } = req.body;
            if (!id || !name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'Thiếu ID hoặc tên đợt kiểm kê cần cập nhật!' });
            }

            const cleanId = parseInt(id, 10);
            const rawName = decryptData(name).trim();
            const encName = encryptData(rawName);
            const rawActiveNum = getRawActiveNumber(active);
            const encActive = encryptData(rawActiveNum.toString());

            const [result] = await connection.execute(
                'UPDATE dot_kiem_ke SET name = ?, active = ? WHERE id = ?',
                [encName, encActive, cleanId]
            );

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã cập nhật đợt kiểm kê thành công!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê cần cập nhật!' });
            }
        }

        if (action === 'toggle_dot_active' && req.method === 'POST') {
            const { id, active } = req.body;
            if (!id || active === undefined) {
                return res.status(400).json({ success: false, error: 'Thiếu ID hoặc trạng thái active!' });
            }

            const cleanId = parseInt(id, 10);
            const rawActiveNum = getRawActiveNumber(active);
            const encActive = encryptData(rawActiveNum.toString());

            const [result] = await connection.execute(
                'UPDATE dot_kiem_ke SET active = ? WHERE id = ?',
                [encActive, cleanId]
            );

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã thay đổi trạng thái kích hoạt!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê!' });
            }
        }

        if (action === 'delete_dot' && req.method === 'POST') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'Thiếu ID đợt kiểm kê cần xóa!' });
            }

            const [result] = await connection.execute('DELETE FROM dot_kiem_ke WHERE id = ?', [parseInt(id, 10)]);

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã xóa đợt kiểm kê thành công!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê cần xóa!' });
            }
        }

        // ----------------------------------------------------
        // 2. PHÂN TRANG DATATABLE TÀI SẢN
        // ----------------------------------------------------
        if (action === 'server_assets') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const searchValue = req.query.search && req.query.search.value ? req.query.search.value.trim() : '';

            let baseWhereClause = '';
            let searchParams = [];

            if (searchValue) {
                baseWhereClause = ' WHERE ma_tai_san LIKE ? OR ten_tai_san LIKE ? OR phong_ban_quan_ly LIKE ?';
                const searchParam = `%${searchValue}%`;
                searchParams = [searchParam, searchParam, searchParam];
            }

            const [totalResult] = await connection.execute('SELECT COUNT(*) as total FROM danh_sach_tai_san');
            const totalRecords = totalResult[0].total;

            const countQuery = `SELECT COUNT(*) as total FROM danh_sach_tai_san${baseWhereClause}`;
            const [filteredResult] = await connection.execute(countQuery, searchParams);
            const recordsFiltered = filteredResult[0].total;

            const limitVal = Math.max(1, parseInt(length));
            const offsetVal = Math.max(0, parseInt(start));
            
            const dataQuery = `SELECT * FROM danh_sach_tai_san${baseWhereClause} ORDER BY ma_tai_san DESC LIMIT ? OFFSET ?`;
            const [rows] = await connection.execute(dataQuery, [...searchParams, limitVal, offsetVal]);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: recordsFiltered,
                data: rows
            });
        }

        // ----------------------------------------------------
        // 3. PHÂN TRANG DATATABLE LỊCH SỬ KIỂM KÊ
        // ----------------------------------------------------
        if (action === 'server_history') {
            const draw = parseInt(req.query.draw) || 1;
            const start = parseInt(req.query.start) || 0;
            const length = parseInt(req.query.length) || 10;
            const selectedDotId = req.query.dot_id ? String(req.query.dot_id).trim() : '';

            const [allRows] = await connection.execute('SELECT * FROM lich_su_kk ORDER BY id DESC');
            const [allDots] = await connection.execute('SELECT id, name, active FROM dot_kiem_ke');

            const dotMap = new Map();
            allDots.forEach(d => {
                dotMap.set(String(d.id), { name: d.name, active: d.active });
            });

            const processedRows = allRows.map(row => {
                const decryptedDotId = (decryptData(row.dotId) || row.dotId || '').toString().trim();
                const dotInfo = dotMap.get(decryptedDotId) || dotMap.get(String(row.dotId).trim());

                return {
                    ...row,
                    realDotId: decryptedDotId,
                    dotName: dotInfo ? dotInfo.name : null,
                    dotActive: dotInfo ? dotInfo.active : null
                };
            });

            let filteredRows = processedRows;
            if (selectedDotId) {
                filteredRows = processedRows.filter(row => 
                    row.realDotId === selectedDotId || String(row.dotId).trim() === selectedDotId
                );
            }

            const totalRecords = processedRows.length;
            const recordsFiltered = filteredRows.length;
            const paginatedRows = filteredRows.slice(start, start + length);

            return res.json({
                draw: draw,
                recordsTotal: totalRecords,
                recordsFiltered: recordsFiltered,
                data: paginatedRows
            });
        }

        // ----------------------------------------------------
        // 4. CẬP NHẬT / THÊM TÀI SẢN (KÈM GHI AUDIT LOG)
        // ----------------------------------------------------
        if (action === 'save_asset' && req.method === 'POST') {
            const { 
                ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, 
                can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at,
                duplicateAction, currentUser
            } = req.body;

            if (!ma_tai_san || !ten_tai_san || !phong_ban_quan_ly) {
                return res.status(400).json({ success: false, error: 'Thiếu trường bắt buộc!' });
            }

            const decryptedNewMaTS = decryptData(ma_tai_san);
            const [allAssets] = await connection.execute('SELECT * FROM danh_sach_tai_san');

            let matchedExistingRow = null;
            for (let row of allAssets) {
                if (decryptData(row.ma_tai_san) === decryptedNewMaTS) {
                    matchedExistingRow = row; 
                    break;
                }
            }

            const newDataObj = { don_vi, ten_tai_san, nhom_tai_san, phong_ban_quan_ly, so_serial, trang_thai_sd };

            if (matchedExistingRow) {
                if (duplicateAction === 'skip') {
                    return res.json({ success: true, skipped: true });
                }

                await connection.execute(
                    `UPDATE danh_sach_tai_san SET 
                    don_vi = ?, ten_tai_san = ?, nhom_tai_san = ?, 
                    nguyen_gia = ?, hao_mon_luy_ke = ?, gia_tri_con_lai = ?, 
                    ngay_dua_vao_sd = ?, trang_thai_sd = ?, trang_thai_qt = ?, bo_so = ?, 
                    can_bo_su_dung = ?, phong_ban_quan_ly = ?, so_serial = ?, hinh_anh = ?, import_at = ? 
                    WHERE ma_tai_san = ?`,
                    [don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at, matchedExistingRow.ma_tai_san]
                );

                // Ghi Audit Log Cập nhật
                await logAssetAction(connection, {
                    ts_id: decryptedNewMaTS,
                    action_type: 'UPDATE',
                    performed_by: currentUser || 'Hệ thống',
                    old_data: matchedExistingRow,
                    new_data: newDataObj,
                    note: 'Cập nhật thông tin tài sản'
                });

                return res.json({ success: true, message: 'Cập nhật thành công!' });
            } else {
                await connection.execute(
                    `INSERT INTO danh_sach_tai_san 
                    (ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at]
                );

                // Ghi Audit Log Tạo mới
                await logAssetAction(connection, {
                    ts_id: decryptedNewMaTS,
                    action_type: 'CREATE',
                    performed_by: currentUser || 'Hệ thống',
                    old_data: null,
                    new_data: newDataObj,
                    note: 'Thêm mới tài sản vào danh mục'
                });

                return res.json({ success: true, message: 'Thêm mới thành công!' });
            }
        }

        // ----------------------------------------------------
        // 5. XÓA TÀI SẢN (KÈM GHI AUDIT LOG)
        // ----------------------------------------------------
        if (action === 'delete_asset' && req.method === 'POST') {
            const { ma_tai_san, currentUser } = req.body;
            
            if (!ma_tai_san) {
                return res.status(400).json({ success: false, error: 'Thiếu mã tài sản cần xóa!' });
            }

            const targetMaTS = ma_tai_san.toString().trim();
            const [allAssets] = await connection.execute('SELECT * FROM danh_sach_tai_san');

            let matchedDbRow = null;
            for (let row of allAssets) {
                let decMa = decryptData(row.ma_tai_san).trim();
                if (decMa === targetMaTS || row.ma_tai_san === targetMaTS) {
                    matchedDbRow = row;
                    break;
                }
            }

            if (!matchedDbRow) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy mã tài sản cần xóa trong CSDL!' });
            }

            const [result] = await connection.execute('DELETE FROM danh_sach_tai_san WHERE ma_tai_san = ?', [matchedDbRow.ma_tai_san]);

            if (result.affectedRows > 0) {
                // Ghi Audit Log Xóa
                await logAssetAction(connection, {
                    ts_id: targetMaTS,
                    action_type: 'DELETE',
                    performed_by: currentUser || 'Hệ thống',
                    old_data: matchedDbRow,
                    new_data: null,
                    note: 'Xóa tài sản khỏi danh mục'
                });

                return res.json({ success: true, message: 'Đã xóa tài sản thành công!' });
            } else {
                return res.status(500).json({ success: false, error: 'Xóa thất bại!' });
            }
        }

        // ----------------------------------------------------
        // 6. GHI LỊCH SỬ KIỂM KÊ (KÈM GHI AUDIT LOG)
        // ----------------------------------------------------
        if (action === 'history' && req.method === 'POST') {
            const { 
                tsId, phong_ban, so_serial, nguoiKK, ghiChu, 
                dotId, ket_qua_kk, phuong_an_xl, tep_dinh_kem, thoiGian, tsName 
            } = req.body;

            if (!dotId || !tsId) {
                return res.status(400).json({ success: false, error: 'Thiếu thông tin Đợt kiểm kê hoặc Mã tài sản!' });
            }

            const rawTargetDotId = decryptData(dotId).trim();
            const rawTargetTsId = decryptData(tsId).trim();

            const [allHistories] = await connection.execute('SELECT dotId, tsId FROM lich_su_kk');

            let isDuplicate = false;
            for (let row of allHistories) {
                const dbDotIdDecrypted = decryptData(row.dotId).trim();
                const dbTsIdDecrypted = decryptData(row.tsId).trim();

                if (dbDotIdDecrypted === rawTargetDotId && dbTsIdDecrypted === rawTargetTsId) {
                    isDuplicate = true;
                    break;
                }
            }

            if (isDuplicate) {
                return res.status(200).json({ 
                    success: false, 
                    error: `Tài sản [${rawTargetTsId}] đã được kiểm kê trong đợt này!` 
                });
            }

            const encTsId = encryptData(rawTargetTsId);
            const encPhongBan = encryptData(decryptData(phong_ban));
            const encSerial = encryptData(decryptData(so_serial));
            const encNguoiKK = encryptData(decryptData(nguoiKK));
            const encGhiChu = encryptData(decryptData(ghiChu));
            const encDotId = encryptData(rawTargetDotId);
            const encKetQua = encryptData(decryptData(ket_qua_kk || 'Khớp danh mục'));
            const encPhuongAn = encryptData(decryptData(phuong_an_xl || 'Giữ nguyên'));
            const encTepDinhKem = encryptData(decryptData(tep_dinh_kem || ''));
            const encThoiGian = encryptData(decryptData(thoiGian));
            const encTsName = encryptData(decryptData(tsName));

            await connection.execute(
                `INSERT INTO lich_su_kk 
                (tsId, phong_ban, so_serial, nguoiKK, ghiChu, dotId, ket_qua_kk, phuong_an_xl, tep_dinh_kem, thoiGian, tsName) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [encTsId, encPhongBan, encSerial, encNguoiKK, encGhiChu, encDotId, encKetQua, encPhuongAn, encTepDinhKem, encThoiGian, encTsName]
            );

            // Ghi Audit Log Kiểm kê
            await logAssetAction(connection, {
                ts_id: rawTargetTsId,
                action_type: 'AUDIT',
                performed_by: decryptData(nguoiKK) || 'Cán bộ kiểm kê',
                old_data: null,
                new_data: { dotId: rawTargetDotId, ket_qua_kk: decryptData(ket_qua_kk), phuong_an_xl: decryptData(phuong_an_xl) },
                note: `Thực hiện kiểm kê cho đợt ID [${rawTargetDotId}]`
            });

            return res.json({ success: true, message: 'Đã ghi nhận lịch sử kiểm kê!' });
        }

        // ----------------------------------------------------
        // 7. ACTION POST: LẤY NHẬT KÝ TÁC ĐỘNG (AUDIT LOGS)
        // ----------------------------------------------------
        if (action === 'get_asset_logs' && req.method === 'POST') {
            const ts_id = req.body && req.body.ts_id ? String(req.body.ts_id).trim() : '';

            if (!ts_id) {
                return res.status(200).json({ success: false, message: 'Thiếu mã tài sản!' });
            }

            const sql = `SELECT * FROM asset_audit_logs WHERE ts_id = ? ORDER BY id DESC`;
            const [rows] = await connection.execute(sql, [ts_id]);

            const logs = rows.map(item => ({
                id: item.id,
                ts_id: item.ts_id,
                action_type: item.action_type,
                performed_by: decryptData(item.performed_by) || item.performed_by || 'Hệ thống',
                old_data: item.old_data ? JSON.parse(item.old_data) : null,
                new_data: item.new_data ? JSON.parse(item.new_data) : null,
                note: decryptData(item.note) || item.note,
                created_at: item.created_at
            }));

            return res.json({ success: true, data: logs });
        }

        // ----------------------------------------------------
        // 8. XUẤT BÁO CÁO EXCEL / CSV
        // ----------------------------------------------------
        if (action === 'export_excel') {
            const selectedDotId = req.query.dot_id ? String(req.query.dot_id).trim() : '';

            const [allRows] = await connection.execute('SELECT * FROM lich_su_kk ORDER BY id DESC');
            const [allDots] = await connection.execute('SELECT id, name FROM dot_kiem_ke');

            const dotMap = new Map();
            allDots.forEach(d => dotMap.set(String(d.id), decryptData(d.name) || d.name));

            let filteredRows = allRows;
            if (selectedDotId) {
                filteredRows = allRows.filter(row => {
                    const decryptedDotId = (decryptData(row.dotId) || row.dotId || '').toString().trim();
                    return decryptedDotId === selectedDotId || String(row.dotId).trim() === selectedDotId;
                });
            }

            let csvContent = "\uFEFF";
            csvContent += "STT,Đợt Kiểm Kê,Mã Tài Sản,Tên Tài Sản,Phòng Ban,Số Serial,Cán Bộ Kiểm Kê,Kết Quả KK,Phương Án Xử Lý,Thời Gian,Ghi Chú\n";

            filteredRows.forEach((row, index) => {
                const decryptedDotId = (decryptData(row.dotId) || row.dotId || '').toString().trim();
                const dotName = dotMap.get(decryptedDotId) || decryptedDotId;

                const tsName = decryptData(row.tsName) || row.tsName || '';
                const phong_ban = decryptData(row.phong_ban) || row.phong_ban || '';
                const so_serial = decryptData(row.so_serial) || row.so_serial || '';
                const ket_qua_kk = decryptData(row.ket_qua_kk) || row.ket_qua_kk || '';
                const phuong_an_xl = decryptData(row.phuong_an_xl) || row.phuong_an_xl || '';
                const ghiChu = decryptData(row.ghiChu) || row.ghiChu || '';
                const realTsId = decryptData(row.tsId) || row.tsId || '';

                csvContent += `"\({index + 1}","\){dotName}","\({realTsId}","\){tsName}","\({phong_ban}","\){so_serial}","\({row.nguoiKK || ''}","\){ket_qua_kk}","\({phuong_an_xl}","\){row.thoiGian || ''}","${ghiChu}"\n`;
            });

            const fileName = `Bao_Cao_Kiem_Ke_${Date.now()}.csv`;
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
            return res.send(csvContent);
        }

        // ----------------------------------------------------
        // 9. UPLOAD & DELETE GOOGLE DRIVE (QỦA APPS SCRIPT)
        // ----------------------------------------------------
        if (action === 'upload_drive' && req.method === 'POST') {
            const { fileName, fileData, mimeType } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL!' });
            }

            const response = await fetch(SCRIPT_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'upload', fileName, fileData, mimeType })
            });

            const textRes = await response.text();
            try {
                return res.json(JSON.parse(textRes));
            } catch (err) {
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive.' });
            }
        }

        if (action === 'delete_drive' && req.method === 'POST') {
            const { fileUrl, fileId } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL!' });
            }

            const response = await fetch(SCRIPT_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete_drive', fileUrl, fileId })
            });

            const textRes = await response.text();
            try {
                return res.json(JSON.parse(textRes));
            } catch (err) {
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive.' });
            }
        }

        return res.status(404).json({ success: false, error: 'Action không hợp lệ!' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) {
            try { await connection.end(); } catch (e) {}
        }
    }
};
