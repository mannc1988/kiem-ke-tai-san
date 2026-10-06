const mysql = require('mysql2/promise');
const CryptoJS = require('crypto-js');
const fetch = require('node-fetch');

// Cấu hình khóa bí mật AES
const SECRET_KEY = 'ManNC@2026_SecureKeyAivenMySQL!';

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

// Hàm chuẩn hóa giá trị active về dạng số thuần (1 hoặc 0) trước khi mã hóa lại
function getRawActiveNumber(activeInput) {
    if (activeInput === undefined || activeInput === null || activeInput === '') return 1;
    const decrypted = decryptData(activeInput).toString().trim();
    const val = Number(decrypted);
    return isNaN(val) ? 1 : (val !== 0 ? 1 : 0);
}

// Helper: Ghi nhật ký tác động (Audit Log)
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
            action_type,
            encUser,
            old_data ? JSON.stringify(old_data) : null,
            new_data ? JSON.stringify(new_data) : null,
            encNote
        ]);
    } catch (err) {
        console.error('Lỗi khi ghi Audit Log:', err);
    }
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    const action = req.query.action || (req.body && req.body.action);
    let connection;

    try {
        if (!action) {
            return res.status(400).json({ success: false, error: 'Thiếu tham số action yêu cầu' });
        }

        connection = await mysql.createConnection(dbConfig);

        // ACTION: GET_ASSET_LOGS
        if (action === 'get_asset_logs') {
            try {
                const ts_id = (req.body && req.body.ts_id) || req.query.ts_id || '';

                if (!ts_id.toString().trim()) {
                    return res.status(200).json({ success: false, message: 'Thiếu mã tài sản!' });
                }

                const sql = `SELECT * FROM asset_audit_logs WHERE ts_id = ? ORDER BY id DESC`;
                const [rows] = await connection.execute(sql, [ts_id.toString().trim()]);

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

                return res.status(200).json({ success: true, data: logs });
            } catch (err) {
                console.error('Lỗi get_asset_logs:', err);
                return res.status(500).json({ success: false, error: err.message });
            }
        }

        // 1. LẤY DỮ LIỆU BAN ĐẦU
        if (action === 'data') {
            const dot_id = req.query.dot_id;

            const [danh_sach] = await connection.execute('SELECT * FROM danh_sach_tai_san ORDER BY ma_tai_san DESC');
            const [dotRows] = await connection.execute('SELECT * FROM dot_kiem_ke ORDER BY id DESC');

            let sqlLichSu = 'SELECT * FROM lich_su_kk';
            let paramsLichSu = [];

            if (dot_id && dot_id.trim() !== '') {
                sqlLichSu += ' WHERE dot_id = ? ORDER BY id DESC';
                paramsLichSu.push(dot_id.trim());
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

        // 1.1 TẠO MỚI ĐỢT KIỂM KÊ
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

        // 1.2 CẬP NHẬT ĐỢT KIỂM KÊ
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

        // 1.3 BẬT/TẮT ACTIVE NHANH
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

        // 1.4 XÓA ĐỢT KIỂM KÊ
        if (action === 'delete_dot' && req.method === 'POST') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'Thiếu ID đợt kiểm kê cần xóa!' });
            }

            const cleanId = parseInt(id, 10);

            const [result] = await connection.execute(
                'DELETE FROM dot_kiem_ke WHERE id = ?',
                [cleanId]
            );

            if (result.affectedRows > 0) {
                return res.json({ success: true, message: 'Đã xóa đợt kiểm kê thành công!' });
            } else {
                return res.status(404).json({ success: false, error: 'Không tìm thấy đợt kiểm kê cần xóa!' });
            }
        }

        // 2. PHÂN TRANG DATATABLE DANH MỤC TÀI SẢN
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

        // 3. PHÂN TRANG DATATABLE LỊCH SỬ KIỂM KÊ
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

        // 4. LƯU TỪNG TÀI SẢN LẺ (KÈM GHI AUDIT LOG)
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

            const newData = {
                don_vi: decryptData(don_vi) || don_vi,
                ten_tai_san: decryptData(ten_tai_san) || ten_tai_san,
                nhom_tai_san: decryptData(nhom_tai_san) || nhom_tai_san,
                phong_ban_quan_ly: decryptData(phong_ban_quan_ly) || phong_ban_quan_ly,
                so_serial: decryptData(so_serial) || so_serial,
                trang_thai_sd: decryptData(trang_thai_sd) || trang_thai_sd
            };

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

                // Ghi Log Cập nhật
                await logAssetAction(connection, {
                    ts_id: decryptedNewMaTS,
                    action_type: 'UPDATE',
                    performed_by: currentUser || 'Hệ thống',
                    old_data: matchedExistingRow,
                    new_data: newData,
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

                // Ghi Log Tạo mới
                await logAssetAction(connection, {
                    ts_id: decryptedNewMaTS,
                    action_type: 'CREATE',
                    performed_by: currentUser || 'Hệ thống',
                    old_data: null,
                    new_data: newData,
                    note: 'Thêm mới tài sản vào hệ thống'
                });

                return res.json({ success: true, message: 'Thêm mới thành công!' });
            }
        }

        // 4.1. LƯU TÀI SẢN THEO LÔ
        if (action === 'save_asset_batch' && req.method === 'POST') {
            const { payloads, duplicateAction, currentUser } = req.body;

            if (!payloads || !Array.isArray(payloads) || payloads.length === 0) {
                return res.status(400).json({ success: false, error: 'Không có dữ liệu hợp lệ để lưu theo lô!' });
            }

            let successCount = 0;
            let skipCount = 0;
            let batchErrors = [];

            const [allAssets] = await connection.execute('SELECT ma_tai_san FROM danh_sach_tai_san');

            for (let i = 0; i < payloads.length; i++) {
                const p = payloads[i];
                const { 
                    ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, 
                    nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, 
                    ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, 
                    can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at 
                } = p;

                if (!ma_tai_san || !ten_tai_san || !phong_ban_quan_ly) {
                    batchErrors.push(`Dòng ${i + 1}: Thiếu trường bắt buộc.`);
                    continue;
                }

                const decryptedNewMaTS = decryptData(ma_tai_san);
                let matchedExistingDbKey = null;
                for (let row of allAssets) {
                    if (decryptData(row.ma_tai_san) === decryptedNewMaTS) {
                        matchedExistingDbKey = row.ma_tai_san; 
                        break;
                    }
                }

                if (matchedExistingDbKey) {
                    if (duplicateAction === 'skip') {
                        skipCount++;
                        continue;
                    }

                    if (duplicateAction === 'update' || !duplicateAction) {
                        try {
                            await connection.execute(
                                `UPDATE danh_sach_tai_san SET 
                                don_vi = ?, ten_tai_san = ?, nhom_tai_san = ?, 
                                nguyen_gia = ?, hao_mon_luy_ke = ?, gia_tri_con_lai = ?, 
                                ngay_dua_vao_sd = ?, trang_thai_sd = ?, trang_thai_qt = ?, bo_so = ?, 
                                can_bo_su_dung = ?, phong_ban_quan_ly = ?, so_serial = ?, hinh_anh = ?, import_at = ? 
                                WHERE ma_tai_san = ?`,
                                [don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at, matchedExistingDbKey]
                            );
                            successCount++;

                            await logAssetAction(connection, {
                                ts_id: decryptedNewMaTS,
                                action_type: 'UPDATE',
                                performed_by: currentUser || 'Hệ thống (Import)',
                                old_data: null,
                                new_data: { ten_tai_san: decryptData(ten_tai_san), phong_ban_quan_ly: decryptData(phong_ban_quan_ly) },
                                note: 'Cập nhật tài sản qua Import Excel theo lô'
                            });
                        } catch (updateErr) {
                            batchErrors.push(`Lỗi cập nhật mã \({decryptedNewMaTS}:\){updateErr.message}`);
                        }
                    }
                } else {
                    try {
                        await connection.execute(
                            `INSERT INTO danh_sach_tai_san 
                            (ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at) 
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [ma_tai_san, don_vi, ten_tai_san, nhom_tai_san, nguyen_gia, hao_mon_luy_ke, gia_tri_con_lai, ngay_dua_vao_sd, trang_thai_sd, trang_thai_qt, bo_so, can_bo_su_dung, phong_ban_quan_ly, so_serial, hinh_anh, import_at]
                        );
                        successCount++;
                        allAssets.push({ ma_tai_san });

                        await logAssetAction(connection, {
                            ts_id: decryptedNewMaTS,
                            action_type: 'CREATE',
                            performed_by: currentUser || 'Hệ thống (Import)',
                            old_data: null,
                            new_data: { ten_tai_san: decryptData(ten_tai_san), phong_ban_quan_ly: decryptData(phong_ban_quan_ly) },
                            note: 'Thêm mới tài sản qua Import Excel theo lô'
                        });
                    } catch (insertErr) {
                        batchErrors.push(`Lỗi thêm mới mã \({decryptedNewMaTS}:\){insertErr.message}`);
                    }
                }
            }

            return res.json({ success: true, successCount, skipCount, errors: batchErrors });
        }

        // 5. XÓA TÀI SẢN (KÈM GHI AUDIT LOG)
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
                // Ghi Log Xóa
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
                return res.status(500).json({ success: false, error: 'Xóa thất bại, không có dòng nào bị ảnh hưởng!' });
            }
        }

        // 6. GHI NHẬN LỊCH SỬ QR (KÈM GHI AUDIT LOG)
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

            // Ghi Log Kiểm kê
            await logAssetAction(connection, {
                ts_id: rawTargetTsId,
                action_type: 'AUDIT',
                performed_by: decryptData(nguoiKK) || 'Cán bộ kiểm kê',
                old_data: null,
                new_data: { 
                    dotId: rawTargetDotId, 
                    ket_qua_kk: decryptData(ket_qua_kk), 
                    phuong_an_xl: decryptData(phuong_an_xl) 
                },
                note: `Thực hiện kiểm kê tài sản cho đợt ID [${rawTargetDotId}]`
            });

            return res.json({ success: true, message: 'Đã ghi nhận lịch sử kiểm kê!' });
        }

        // 7. XÓA LỊCH SỬ
        if (action === 'delete_history' && req.method === 'POST') {
            const { id } = req.body;
            await connection.execute('DELETE FROM lich_su_kk WHERE id = ?', [id]);
            return res.json({ success: true, message: 'Đã xóa lịch sử!' });
        }

        // 7.1. CẬP NHẬT LỊCH SỬ KIỂM KÊ
        if (action === 'update_history' && req.method === 'POST') {
            const { id, phong_ban, so_serial, nguoiKK, ket_qua_kk, phuong_an_xl, tep_dinh_kem, ghiChu } = req.body;

            if (!id) {
                return res.status(400).json({ success: false, error: 'Thiếu ID lịch sử cần cập nhật!' });
            }

            const encPhongBan = encryptData(decryptData(phong_ban));
            const encSerial = encryptData(decryptData(so_serial));
            const encNguoiKK = encryptData(decryptData(nguoiKK));
            const encKetQua = encryptData(decryptData(ket_qua_kk));
            const encPhuongAn = encryptData(decryptData(phuong_an_xl));
            const encTepDinhKem = encryptData(decryptData(tep_dinh_kem || ''));
            const encGhiChu = encryptData(decryptData(ghiChu));

            await connection.execute(
                `UPDATE lich_su_kk SET 
                phong_ban = ?, so_serial = ?, nguoiKK = ?, ket_qua_kk = ?, phuong_an_xl = ?, tep_dinh_kem = ?, ghiChu = ? 
                WHERE id = ?`,
                [encPhongBan, encSerial, encNguoiKK, encKetQua, encPhuongAn, encTepDinhKem, encGhiChu, id]
            );

            return res.json({ success: true, message: 'Đã cập nhật lịch sử thành công!' });
        }

        // 8. UPLOAD MỌI LOẠI FILE QUA GOOGLE APPS SCRIPT WEB APP
        if (action === 'upload_drive' && req.method === 'POST') {
            const { fileName, fileData, mimeType } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL trong biến môi trường!' });
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
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive (không phải JSON).' });
            }
        }

        // 9. XÓA DRIVE THỰC TẾ QUA GOOGLE APPS SCRIPT
        if (action === 'delete_drive' && req.method === 'POST') {
            const { fileUrl, fileId } = req.body;
            const SCRIPT_WEB_APP_URL = process.env.GOOGLE_SCRIPT_WEB_APP_URL;

            if (!SCRIPT_WEB_APP_URL) {
                return res.status(500).json({ success: false, error: 'Chưa cấu hình GOOGLE_SCRIPT_WEB_APP_URL!' });
            }

            if (!fileUrl && !fileId) {
                return res.status(400).json({ success: false, error: 'Thiếu fileUrl hoặc fileId để xóa!' });
            }

            const response = await fetch(SCRIPT_WEB_APP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    action: 'delete_drive', 
                    fileUrl: fileUrl, 
                    fileId: fileId 
                })
            });

            const textRes = await response.text();
            try {
                return res.json(JSON.parse(textRes));
            } catch (err) {
                return res.status(500).json({ success: false, error: 'Lỗi phản hồi từ Google Drive (không phải JSON).' });
            }
        }

        // 10. LOẠI BỎ TỆP DANH MỤC TÀI SẢN KHỎI CSDL
        if (action === 'remove_asset_file' && req.method === 'POST') {
            const { ma_tai_san, removeUrl } = req.body;
            
            if (!ma_tai_san || !removeUrl) {
                return res.status(400).json({ success: false, error: 'Thiếu mã tài sản hoặc URL tệp cần xóa!' });
            }

            const [allAssets] = await connection.execute('SELECT ma_tai_san, hinh_anh FROM danh_sach_tai_san');

            let matchedDbKey = null;
            let currentHinhAnhEncrypted = '';

            for (let row of allAssets) {
                let decMa = decryptData(row.ma_tai_san);
                if (decMa === ma_tai_san || row.ma_tai_san === ma_tai_san) {
                    matchedDbKey = row.ma_tai_san;
                    currentHinhAnhEncrypted = row.hinh_anh;
                    break;
                }
            }

            if (!matchedDbKey) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy tài sản trong CSDL!' });
            }

            let decryptedHinhAnh = decryptData(currentHinhAnhEncrypted) || '';
            let urlList = decryptedHinhAnh.split(',').map(s => s.trim()).filter(Boolean);
            let updatedList = urlList.filter(url => url !== removeUrl.trim());
            
            let newHinhAnhEncrypted = encryptData(updatedList.join(','));

            await connection.execute(
                'UPDATE danh_sach_tai_san SET hinh_anh = ? WHERE ma_tai_san = ?', 
                [newHinhAnhEncrypted, matchedDbKey]
            );

            return res.json({ 
                success: true, 
                message: 'Đã cập nhật CSDL thành công!',
                remainingUrls: updatedList.join(',')
            });
        }

        // 11. XUẤT BÁO CÁO
        if (action === 'export_excel') {
            try {
                const selectedDotId = req.query.dot_id ? String(req.query.dot_id).trim() : '';

                const [allRows] = await connection.execute('SELECT * FROM lich_su_kk ORDER BY id DESC');
                const [allDots] = await connection.execute('SELECT id, name FROM dot_kiem_ke');

                const dotMap = new Map();
                allDots.forEach(d => dotMap.set(String(d.id), d.name));

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
                    const dotName = dotMap.get(decryptedDotId) || dotMap.get(String(row.dotId).trim()) || decryptedDotId;

                    const tsName = decryptData(row.tsName) || row.tsName || '';
                    const phong_ban = decryptData(row.phong_ban) || row.phong_ban || '';
                    const so_serial = decryptData(row.so_serial) || row.so_serial || '';
                    const ket_qua_kk = decryptData(row.ket_qua_kk) || row.ket_qua_kk || '';
                    const phuong_an_xl = decryptData(row.phuong_an_xl) || row.phuong_an_xl || '';
                    const ghiChu = decryptData(row.ghiChu) || row.ghiChu || '';

                    csvContent += `"\({index + 1}","\){dotName}","\({row.tsId}","\){tsName}","\({phong_ban}","\){so_serial}","\({row.nguoiKK || ''}","\){ket_qua_kk}","\({phuong_an_xl}","\){row.thoiGian || ''}","${ghiChu}"\n`;
                });

                const fileName = `Bao_Cao_Kiem_Ke_${Date.now()}.csv`;
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
                return res.send(csvContent);

            } catch (error) {
                return res.status(500).json({ success: false, message: 'Lỗi xuất báo cáo: ' + error.message });
            }
        }

        // 12. LOẠI BỎ TỆP LỊCH SỬ KIỂM KÊ KHỎI CSDL
        if (action === 'remove_history_file' && req.method === 'POST') {
            const id = req.body.id || req.body.historyId;
            const removeUrl = req.body.removeUrl;
            
            if (!id || id === 'null' || !removeUrl) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Thiếu ID lịch sử hoặc URL tệp cần xóa!' 
                });
            }

            const cleanId = Number(id);
            const cleanRemoveUrl = removeUrl.toString().trim();

            const [rows] = await connection.execute('SELECT tep_dinh_kem FROM lich_su_kk WHERE id = ?', [cleanId]);

            if (rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Không tìm thấy dòng lịch sử trong CSDL!' });
            }

            let decryptedTep = decryptData(rows[0].tep_dinh_kem) || '';
            let urlList = decryptedTep.split(',').map(s => s.trim()).filter(Boolean);
            let updatedList = urlList.filter(url => url !== cleanRemoveUrl);
            
            let newTepEncrypted = encryptData(updatedList.join(','));

            await connection.execute(
                'UPDATE lich_su_kk SET tep_dinh_kem = ? WHERE id = ?', 
                [newTepEncrypted, cleanId]
            );

            return res.json({ 
                success: true, 
                message: 'Đã cập nhật tệp đính kèm lịch sử trong CSDL thành công!',
                remainingUrls: updatedList.join(',')
            });
        }

        return res.status(404).json({ success: false, error: 'Action không hợp lệ' });

    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    } finally {
        if (connection) {
            try { await connection.end(); } catch (e) {}
        }
    }
};
