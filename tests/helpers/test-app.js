import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { CloudantSessionStore, AuditLogService } from '../../lib/cloudant/index.js';
import { PasskeyService } from '../../lib/passkey/index.js';
import setupAuthRoutes from '../../server/routes/auth.js';
import setupChatRoutes from '../../server/routes/chat.js';
import setupFileRoutes from '../../server/routes/files.js';
import { getTestDbName } from './db.js';

export function createTestApp(cloudant) {
  const app = express();

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(session({
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, httpOnly: true, maxAge: 86400000 },
    store: new CloudantSessionStore({
      cloudantClient: cloudant,
      dbName: getTestDbName('sessions'),
    }),
  }));

  // Health check
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  const passkeyService = new PasskeyService({
    rpID: 'localhost',
    origin: 'http://localhost:5173',
  });

  const auditLog = new AuditLogService(cloudant, getTestDbName('audit_log'));

  // doClient and chatClient are null — routes that need DO will fail gracefully
  const doClient = null;
  const chatClient = null;

  setupAuthRoutes(app, passkeyService, cloudant, doClient, auditLog);
  setupChatRoutes(app, chatClient, cloudant, doClient);
  setupFileRoutes(app, cloudant, doClient);

  return app;
}
