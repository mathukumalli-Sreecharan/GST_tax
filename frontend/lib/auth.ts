export function safeDestination(value: string | null): string {
 if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || Array.from(value).some(character=>character.charCodeAt(0)<=32)) return '/';
 try { const url = new URL(value, 'https://local.invalid');
 return url.origin === 'https://local.invalid' && !/^\/(auth|login|register|forgot-password|reset-password)(\/|$)/.test(url.pathname) ? url.pathname + url.search : '/';
 } catch { return '/'; }
}
