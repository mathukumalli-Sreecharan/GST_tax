export function safeDestination(value: string | null): string {
 if (!value || !/^\/(?![\/\\])/.test(value) || /[\\\x00-\x20]/.test(value)) return '/';
 try { const url = new URL(value, 'https://local.invalid');
 return url.origin === 'https://local.invalid' && !/^\/(auth|login|register|forgot-password|reset-password)(\/|$)/.test(url.pathname) ? url.pathname + url.search : '/';
 } catch { return '/'; }
}
