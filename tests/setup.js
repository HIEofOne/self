import dotenv from 'dotenv';
import { afterAll } from 'vitest';
import { closeServed } from './helpers/serve.js';
dotenv.config();

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

afterAll(closeServed);
