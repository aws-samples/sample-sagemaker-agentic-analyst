import { generateCodeVerifier, generateState } from 'aws-amplify/adapter-core';
import type { NextRequest } from 'next/server';

import { env } from '@/lib/env';

const PKCE_COOKIE = 'com.amplify.server_auth.pkce';
const STATE_COOKIE = 'com.amplify.server_auth.state';
const COOKIE_MAX_AGE = 5 * 60; // 5 minutes (same as Amplify)

/**
 * Amplify の sign-in ハンドラーと同等の PKCE フローを実行し、
 * Cognito へのリダイレクト URL に prompt=login を追加する。
 *
 * Amplify の createAuthRouteHandlers は prompt パラメータを付与しないため、
 * Cognito が前のユーザーのセッションを使い回してユーザー切り替えができない。
 * prompt=login を付与することで Cognito に強制再認証させる。
 */
export async function GET(_request: NextRequest) {
  // SSMパラメータ経由で動的設定されるためprocess.envフォールバックが必要
  const redirectUri = `${env.AMPLIFY_APP_ORIGIN ?? process.env.AMPLIFY_APP_ORIGIN}/api/auth/sign-in-callback`;

  const codeVerifier = generateCodeVerifier(128);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.USER_POOL_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'profile openid aws.cognito.signin.user.admin',
    state,
    code_challenge: codeVerifier.toCodeChallenge(),
    code_challenge_method: codeVerifier.method,
    identity_provider: 'IdC', // Cognito Managed Loginをスキップして直接IdCへ
  });

  const cookieOptions = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
  const headers = new Headers({
    Location: `https://${env.COGNITO_DOMAIN}/oauth2/authorize?${params}`,
    'Set-Cookie': `${PKCE_COOKIE}=${codeVerifier.value}; ${cookieOptions}`,
  });
  headers.append('Set-Cookie', `${STATE_COOKIE}=${state}; ${cookieOptions}`);

  return new Response(null, { status: 302, headers });
}
