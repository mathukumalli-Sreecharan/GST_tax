import { NextRequest, NextResponse } from 'next/server';
import { serverClient } from '@/lib/supabase/server';
import { safeDestination } from '@/lib/auth';
export async function GET(request: NextRequest) {
 const code = request.nextUrl.searchParams.get('code');
 if (code) {
  const client = await serverClient();
  const {error} = await client.auth.exchangeCodeForSession(code);
  if (!error) {
   const recovery = request.nextUrl.searchParams.get('flow') === 'recovery';
   return NextResponse.redirect(new URL(recovery ? '/reset-password' : safeDestination(request.nextUrl.searchParams.get('next')),request.url));
  }
 }
 return NextResponse.redirect(new URL('/login?error=link',request.url));
}
