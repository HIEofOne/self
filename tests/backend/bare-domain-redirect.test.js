/**
 * The bare domain goes to the www address the app is served at
 * (trustee.ai → https://www.trustee.ai), keeping the path and query; POSTs
 * keep their method. Other hosts, and apps not served at a www address,
 * pass straight through.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { serve } from '../helpers/serve.js';
import { bareDomainRedirect } from '../../server/utils/bare-domain-redirect.js';

const appFor = (publicAppUrl) => {
  const app = express();
  const mw = bareDomainRedirect(publicAppUrl);
  if (mw) app.use(mw);
  app.all('*', (req, res) => res.send('app'));
  return app;
};

describe('bare domain → www', () => {
  it('redirects trustee.ai to https://www.trustee.ai with the path and query', async () => {
    const server = await serve(appFor('https://www.trustee.ai'));
    const r = await request(server).get('/g/demo-patients/request?x=1').set('Host', 'trustee.ai');
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('https://www.trustee.ai/g/demo-patients/request?x=1');
    const root = await request(server).get('/').set('Host', 'TRUSTEE.AI:443');
    expect(root.headers.location).toBe('https://www.trustee.ai/');
  });

  it('a POST keeps its method (308)', async () => {
    const server = await serve(appFor('https://www.trustee.ai'));
    const r = await request(server).post('/gnap/tx').set('Host', 'trustee.ai').send({});
    expect(r.status).toBe(308);
  });

  it('the www address and other hosts are served as usual', async () => {
    const server = await serve(appFor('https://www.trustee.ai'));
    expect((await request(server).get('/').set('Host', 'www.trustee.ai')).text).toBe('app');
    expect((await request(server).get('/health').set('Host', 'maia-group-kgy48.ondigitalocean.app')).text).toBe('app');
  });

  it('does nothing for an app not served at a www address, or without https', () => {
    expect(bareDomainRedirect('https://maia.agropper.xyz')).toBeNull();
    expect(bareDomainRedirect('http://www.localhost:5173')).toBeNull();
    expect(bareDomainRedirect('')).toBeNull();
    expect(bareDomainRedirect(undefined)).toBeNull();
  });
});
