import type { NextConfig } from "next";
if (process.env.VERCEL_ENV === 'production') {
 for (const name of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_API_BASE']) {
  const value=process.env[name];
  if (!value || new URL(value).protocol !== 'https:') throw new Error(`${name} must be configured with HTTPS for production.`);
 }
 if (process.env.API_INTERNAL_BASE && new URL(process.env.API_INTERNAL_BASE).protocol !== 'https:') throw new Error('API_INTERNAL_BASE must use HTTPS in production.');
}
const nextConfig: NextConfig = {
 reactStrictMode: true,
 async headers(){return [{source:'/:path*',headers:[{key:'Referrer-Policy',value:'no-referrer'},{key:'X-Content-Type-Options',value:'nosniff'},{key:'X-Frame-Options',value:'DENY'}]}];}
};
export default nextConfig;
