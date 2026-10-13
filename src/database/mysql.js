const mysql = require('mysql2/promise');
const { logToFile } = require('../utils/logger');
const { sslOptions } = require('./ssl');

async function connect() {
    logToFile('Initializing MySQL database connection...');
    const pool = mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        timezone: 'Z', // store and read DATETIME values as UTC
        ssl: sslOptions(process.env.MYSQL_SSL, process.env.MYSQL_SSL_CA),
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS emails (
            id INT AUTO_INCREMENT PRIMARY KEY,
            message_id VARCHAR(998),
            from_address VARCHAR(320) NOT NULL DEFAULT '',
            from_name VARCHAR(255) NOT NULL DEFAULT '',
            to_addresses MEDIUMTEXT NOT NULL,
            cc_addresses MEDIUMTEXT NOT NULL,
            envelope_from VARCHAR(320) NOT NULL DEFAULT '',
            envelope_to MEDIUMTEXT NOT NULL,
            subject TEXT NOT NULL,
            snippet VARCHAR(255) NOT NULL DEFAULT '',
            text_body LONGTEXT,
            html_body LONGTEXT,
            headers MEDIUMTEXT NOT NULL,
            raw LONGBLOB,
            size INT NOT NULL DEFAULT 0,
            attachment_count INT NOT NULL DEFAULT 0,
            smtp_user VARCHAR(255),
            timestamp DATETIME(3) NOT NULL,
            INDEX idx_emails_timestamp (timestamp)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS attachments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            email_id INT NOT NULL,
            filename VARCHAR(1024) NOT NULL,
            content_type VARCHAR(255) NOT NULL,
            content_id VARCHAR(998),
            size INT NOT NULL DEFAULT 0,
            content LONGBLOB,
            INDEX idx_attachments_email (email_id)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS api_keys (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(64) NOT NULL UNIQUE,
            scope VARCHAR(16) NOT NULL,
            key_hash CHAR(64) NOT NULL UNIQUE,
            key_prefix VARCHAR(32) NOT NULL,
            key_encrypted TEXT NOT NULL,
            source VARCHAR(16) NOT NULL DEFAULT 'dashboard',
            created_at DATETIME(3) NOT NULL,
            last_used_at DATETIME(3),
            revoked_at DATETIME(3)
        )
    `);
    return {
        dialect: 'mysql',
        all: async (sql, params = []) => (await pool.query(sql, params))[0],
        run: async (sql, params = []) => (await pool.query(sql, params))[0].affectedRows,
        insert: async (sql, params = []) => (await pool.query(sql, params))[0].insertId,
        close: () => pool.end(),
    };
}

module.exports = connect;
