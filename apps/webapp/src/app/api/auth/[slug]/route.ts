import { createAuthRouteHandlers } from '@/lib/amplifyServerUtils';
import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { env } from '@/lib/env';

const amplifyHandler = createAuthRouteHandlers({
  redirectOnSignInComplete: '/auth-callback',
  redirectOnSignOutComplete: '/api/sign-out-cleanup',
});

/**
 * カスタム認証ルートハンドラー
 *
 * sign-out: Cognito + IdC SAML連携では、SAML SLOがCognitoのlogout_uriを無視して
 * IdCポータルにリダイレクトするため、sign-out-callbackが呼ばれない。
 * ログアウト前にCookieを削除しておく。
 *
 * sign-in-callback: IdP-initiated SSOの場合、state/PKCEのCookieが存在しないため、
 * Amplifyの認証ハンドラーがエラーを返す。SP-initiated SSOにフォールバックする。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const cookieStore = await cookies();

  // sign-out: Cookieを削除してからAmplifyのログアウトフローに進む
  if (slug === 'sign-out') {
    for (const cookie of cookieStore.getAll()) {
      if (
        cookie.name.startsWith('CognitoIdentityServiceProvider.') ||
        cookie.name.startsWith('com.amplify.server_auth.')
      ) {
        cookieStore.set(cookie.name, '', { path: '/', expires: new Date(0) });
      }
    }
    return amplifyHandler(request, context);
  }

  // sign-in-callback以外はAmplifyハンドラーに委譲
  if (slug !== 'sign-in-callback') {
    return amplifyHandler(request, context);
  }

  const stateCookie = cookieStore.get('com.amplify.server_auth.state');
  const pkceCookie = cookieStore.get('com.amplify.server_auth.pkce');

  // SP-initiated SSO: state/PKCEのCookieが存在する場合はAmplifyハンドラーに委譲
  if (stateCookie && pkceCookie) {
    return amplifyHandler(request, context);
  }

  // IdP-initiated SSO: state/PKCEのCookieが存在しない場合
  // SP-initiated SSOにフォールバック
  // SSMパラメータ経由で動的設定されるためprocess.envフォールバックが必要
  const origin = env.AMPLIFY_APP_ORIGIN ?? process.env.AMPLIFY_APP_ORIGIN;

  // /api/auth/sign-in にリダイレクトしてPKCEフローを開始
  // Cognitoが新しい認可コードを発行し、通常のコールバック処理が実行される
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/api/auth/sign-in`,
    },
  });
}
