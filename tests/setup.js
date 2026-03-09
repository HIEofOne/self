import dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
