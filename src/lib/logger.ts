import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';

const logDir = path.join(process.cwd(), 'data', 'logs');
fs.mkdirSync(logDir, { recursive: true });

export const logger = winston.createLogger({
	level: process.env.LOG_LEVEL || 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.json(),
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({
			filename: path.join(logDir, 'app.log'),
			level: 'info',
			maxsize: 10 * 1024 * 1024,
			maxFiles: 5,
			tailable: true,
		}),
	],
});
