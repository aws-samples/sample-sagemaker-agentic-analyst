import { cookies } from 'next/headers';
import { env } from '@/lib/env';

/**
 * Amplify の sign-out-callback が username に URL エンコード文字（+, @）を含む場合、
 * Cookie 名を二重エンコードして削除に失敗するバグがある。
 * ここで残存する Cognito/Amplify Cookie を全て削除してから IdC サインアウトページへリダイレクトする。
 *
 * 注意: cookies().delete(name) は path を指定しないと削除に失敗する場合がある。
 * Amplify は path=/ でCookieを設定するため、明示的に path を指定する。
 */
export async function GET() {
  const cookieStore = await cookies();
  const remainingCookies: string[] = [];

  for (const cookie of cookieStore.getAll()) {
    if (
      cookie.name.startsWith('CognitoIdentityServiceProvider.') ||
      cookie.name.startsWith('com.amplify.server_auth.')
    ) {
      remainingCookies.push(cookie.name);
      // path を明示的に指定して確実に削除
      cookieStore.set(cookie.name, '', { path: '/', expires: new Date(0) });
    }
  }

  if (remainingCookies.length > 0) {
    console.log('[sign-out-cleanup] Remaining cookies after Amplify sign-out:', remainingCookies);
  }

  const destination = env.IDC_PORTAL_URL ? `${env.IDC_PORTAL_URL}#/signout` : '/sign-in';
  return new Response(null, { status: 302, headers: { Location: destination } });
}
