// Talks to the Eye Refs server (the Apps Script in the EyeStudio Google account).
class CloudError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // 'offline' | 'auth' | 'user'
  }
}

class Cloud {
  constructor(getUrl, getToken, fetchImpl) {
    this.getUrl = getUrl;
    this.getToken = getToken;
    this.fetch = fetchImpl;
  }

  async call(action, body = {}, timeoutMs = 60000) {
    const url = this.getUrl();
    if (!url) throw new CloudError('Eye Refs is not connected to EyeStudio yet.', 'offline');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res, text;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        // text/plain keeps Apps Script happy and follows its redirect as a GET
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, token: this.getToken(), ...body }),
        redirect: 'follow',
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      throw new CloudError("Can't reach EyeStudio right now. Your work is saved on this computer.", 'offline');
    } finally {
      clearTimeout(t);
    }
    let out;
    try { out = JSON.parse(text); } catch (_) {
      throw new CloudError('EyeStudio sent an unexpected reply. The connection link may be wrong.', 'offline');
    }
    if (!out.ok) {
      const auth = /sign in again|expired/i.test(out.error || '');
      throw new CloudError(out.error || 'Something went wrong.', auth ? 'auth' : 'user');
    }
    return out.data;
  }

  async ping(url) {
    try {
      const res = await this.fetch(url, { method: 'GET', redirect: 'follow' });
      const out = JSON.parse(await res.text());
      return !!(out && out.ok && out.data && out.data.app === 'Eye Refs');
    } catch (_) {
      return false;
    }
  }
}

module.exports = { Cloud, CloudError };
