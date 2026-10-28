import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { safeDestination } from '@/lib/auth';
export async function middleware(request: NextRequest) {
 let response = NextResponse.next({ request });
 const path = request.nextUrl.pathname;
 const publicRoute = ['/','/login','/register','/forgot-password','/reset-password','/auth/callback'].includes(path);
 const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
 const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
 if (!url || !key) return new NextResponse('The application is temporarily unavailable. Please try again shortly.', {status:503});
 const client = createServerClient(url,key,{cookies:{getAll:()=>request.cookies.getAll(),setAll(values){
  values.forEach(({name,value})=>request.cookies.set(name,value));
  response = NextResponse.next({request});
  values.forEach(({name,value,options})=>response.cookies.set(name,value,options));
 }}});
 const { data: {user} } = await client.auth.getUser();
 let destination: URL | undefined;
 if (!user && !publicRoute) { destination = new URL('/login',request.url); destination.searchParams.set('next', path + request.nextUrl.search); }
 if (user && ['/login','/register'].includes(path)) destination = new URL(safeDestination(request.nextUrl.searchParams.get('next')),request.url);
 if (destination) { const redirect = NextResponse.redirect(destination); response.cookies.getAll().forEach(c=>redirect.cookies.set(c)); response=redirect; }
 response.headers.set('Cache-Control','private, no-store');
 return response;
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
