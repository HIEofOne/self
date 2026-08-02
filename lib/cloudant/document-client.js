/**
 * Cloudant document client for MAIA
 */

import nano from 'nano';

export class CloudantClient {
  constructor(config = {}) {
    const url = config.url || process.env.CLOUDANT_URL;
    const username = config.username || process.env.CLOUDANT_USERNAME || 'admin';
    const password = config.password || process.env.CLOUDANT_PASSWORD;

    if (!url) {
      throw new Error('Cloudant URL is required');
    }

    // Build connection string for Cloudant or local CouchDB
    const hasProtocol = /^https?:\/\//.test(url);
    const protocol = url.startsWith('http://') ? 'http' : 'https';
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const connectionString = `${hasProtocol ? protocol : 'https'}://${username}:${password}@${cleanUrl}`;
    
    this.db = nano(connectionString);
    this.isCloudant = url.includes('cloudant') || url.includes('bluemix');
    // Host:port for logging (no credentials)
    const hostPart = cleanUrl.replace(/^[^@]+@/, '');
    this._targetHost = hostPart || cleanUrl;

    // Per-app database namespace: several MAIA deployments can share one
    // CouchDB instance, each seeing its own `<prefix>maia_*` databases.
    // Applied at the nano boundary only (use/create), so the hundreds of
    // literal database names across the codebase never change. Sanitized
    // to CouchDB-legal name characters; empty (production default) is a
    // no-op that leaves existing databases untouched.
    const rawPrefix = config.dbPrefix ?? process.env.COUCHDB_DB_PREFIX ?? '';
    this.dbPrefix = String(rawPrefix).toLowerCase().replace(/[^a-z0-9_$()+-]/g, '');
    if (this.dbPrefix) {
      console.log(`[Cloudant] Database prefix: "${this.dbPrefix}" (databases resolve as ${this.dbPrefix}maia_*)`);
    }
  }

  /** Resolve a logical database name to its namespaced physical name. */
  _name(databaseName) {
    return `${this.dbPrefix}${databaseName}`;
  }

  /**
   * Handle rate limiting errors with retry logic
   */
  async handleRateLimit(operation, retryCount = 0) {
    try {
      return await operation();
    } catch (error) {
      if (error.statusCode === 429 || error.error === 'too_many_requests') {
        if (retryCount < 3) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.handleRateLimit(operation, retryCount + 1);
        }
        throw new Error('Cloudant rate limit exceeded');
      }
      throw error;
    }
  }

  /**
   * Check if error indicates the database does not exist (not document missing).
   * CouchDB uses error "not_found" + reason "missing" for missing documents;
   * we only treat explicit database-missing signals so getDocument can return null for missing docs.
   */
  isDatabaseMissingError(error) {
    const msg = (error?.message || error?.reason || '').toLowerCase();
    const reason = (error?.reason || '').toLowerCase();
    return (
      msg.includes('database does not exist') ||
      msg.includes('no_db_file') ||
      reason.includes('no_db_file')
    );
  }

  /**
   * Run operation, creating database and retrying once if it doesn't exist
   */
  async withEnsureDatabase(databaseName, operation) {
    try {
      return await operation();
    } catch (error) {
      if (this.isDatabaseMissingError(error)) {
        await this.createDatabase(databaseName);
        return await operation();
      }
      const msg = error?.message || error?.reason || '';
      if (msg.includes('ECONNREFUSED') && this._targetHost) {
        console.error(`[Cloudant] Request failed (${this._targetHost}):`, msg);
      }
      throw error;
    }
  }

  /**
   * Create a database
   */
  async createDatabase(databaseName) {
    return this.handleRateLimit(async () => {
      await this.db.db.create(this._name(databaseName));
      return true;
    }).catch(error => {
      if (error.statusCode === 412) {
        return true; // Already exists
      }
      throw error;
    });
  }

  /**
   * Get a document by ID
   */
  async getDocument(databaseName, documentId) {
    return this.withEnsureDatabase(databaseName, async () => {
      return this.handleRateLimit(async () => {
        const db = this.db.use(this._name(databaseName));
        return await db.get(documentId);
      }).catch(error => {
        if (this.isDatabaseMissingError(error)) throw error;
        if (error.statusCode === 404) return null;
        throw error;
      });
    });
  }

  /**
   * Save a document (insert or update)
   */
  async saveDocument(databaseName, document) {
    return this.withEnsureDatabase(databaseName, async () => {
      return this.handleRateLimit(async () => {
        const db = this.db.use(this._name(databaseName));
        
        // If document has _id but no _rev, try to get existing revision
        if (document._id && !document._rev) {
          try {
            const existing = await db.get(document._id);
            document._rev = existing._rev;
          } catch (error) {
            if (error.statusCode !== 404) {
              throw error;
            }
          }
        }
        
        const result = await db.insert(document);
        return {
          id: result.id,
          rev: result.rev,
          ok: result.ok
        };
      });
    });
  }

  /**
   * Delete a document
   */
  async deleteDocument(databaseName, documentId) {
    return this.withEnsureDatabase(databaseName, async () => {
      return this.handleRateLimit(async () => {
        const db = this.db.use(this._name(databaseName));
        const doc = await db.get(documentId);
        return await db.destroy(documentId, doc._rev);
      });
    });
  }

  /**
   * Find documents using a query
   */
  async findDocuments(databaseName, query) {
    return this.withEnsureDatabase(databaseName, async () => {
      return this.handleRateLimit(async () => {
        const db = this.db.use(this._name(databaseName));
        return await db.find(query);
      });
    });
  }

  /**
   * Get all documents in a database
   */
  async getAllDocuments(databaseName) {
    return this.withEnsureDatabase(databaseName, async () => {
      return this.handleRateLimit(async () => {
        const db = this.db.use(this._name(databaseName));
        const result = await db.list({ include_docs: true });
        return result.rows.map(row => row.doc);
      });
    });
  }

  /**
   * Test the connection
   */
  async testConnection() {
    try {
      if (this._targetHost) {
        console.log(`[Cloudant] Connecting to ${this._targetHost}...`);
      }
      await this.db.info();
      if (this._targetHost) {
        console.log(`[Cloudant] Connected to ${this._targetHost}`);
      }
      return true;
    } catch (error) {
      const reason = error.message || error.reason || error.description || String(error);
      const statusCode = error.statusCode || error.status;
      console.error(`[Cloudant] Connection failed (${this._targetHost || 'unknown'}):`, reason);
      if (reason.includes('ECONNREFUSED') && this._targetHost) {
        console.error(`[Cloudant] Tip: Check droplet is running, port 5984 is open (ufw allow 5984), and CouchDB is bound to 0.0.0.0`);
      }
      // Return 'auth_error' for 401/403 so callers can bail immediately
      // instead of retrying and triggering CouchDB brute-force lockout
      if (statusCode === 401 || statusCode === 403 ||
          reason.includes('Name or password is incorrect') ||
          reason.includes('temporarily locked')) {
        return 'auth_error';
      }
      return false;
    }
  }
}

