import {AuthFrame} from '@/components/AuthFrame';
export default function AuthLayout({children}:{children:React.ReactNode}) {
 return <AuthFrame>{children}</AuthFrame>;
}
