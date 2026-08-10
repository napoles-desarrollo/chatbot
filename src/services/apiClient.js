const http = require('http');
const https = require('https');

class ApiClient {
    constructor(baseUrl, token) {
        this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
        this.token = token || '';
    }

    disponible() {
        return Boolean(this.baseUrl);
    }

    async get(path, params = {}) {
        return this.request('GET', path, null, params);
    }

    async post(path, body = {}) {
        return this.request('POST', path, body);
    }

    async request(method, path, body = null, params = {}) {
        if (!this.baseUrl) {
            throw new Error('API no configurada');
        }

        const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
        Object.entries(params || {}).forEach(([key, value]) => {
            if (value !== undefined && value !== null && value !== '') {
                url.searchParams.set(key, String(value));
            }
        });

        const payload = body ? JSON.stringify(body) : null;
        const headers = {
            'Accept': 'application/json'
        };

        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        return new Promise((resolve, reject) => {
            const client = url.protocol === 'https:' ? https : http;
            const req = client.request(url, { method, headers, timeout: 15000 }, res => {
                let response = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { response += chunk; });
                res.on('end', () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`API ${method} ${url.pathname} respondió HTTP ${res.statusCode}`));
                        return;
                    }

                    if (!response.trim()) {
                        resolve(null);
                        return;
                    }

                    try {
                        resolve(JSON.parse(response));
                    } catch (e) {
                        reject(new Error(`Respuesta JSON inválida: ${e.message}`));
                    }
                });
            });

            req.on('timeout', () => req.destroy(new Error(`Timeout API ${method} ${url.pathname}`)));
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }
}

module.exports = ApiClient;
