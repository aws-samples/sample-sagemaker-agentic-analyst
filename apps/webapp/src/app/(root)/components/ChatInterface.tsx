'use client';

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Send, Loader2, User, Bot, Sparkles, ZoomIn, Brain, Wrench, ChevronRight } from 'lucide-react';
import { Streamdown, defaultRehypePlugins } from 'streamdown';
import 'streamdown/styles.css';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { parseImageEvent } from '@/lib/chat-utils';
import { ProjectRequiredPlaceholder } from '@/components/ProjectRequiredPlaceholder';
import type { SSEEvent } from '@agentic-analyst/shared-types';

interface ThinkingStep {
  type: 'thinking';
  text: string;
}

interface ToolStep {
  type: 'tool';
  name: string;
}

type Step = ThinkingStep | ToolStep;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: { data: string; mimeType: string }[];
  steps?: Step[];
  /** fadingアニメーション中の中間テキスト（contentとは別に縦に並べて表示） */
  fadingTexts?: { id: number; text: string }[];
}

/** Runtimeレスポンスからテキストを抽出 */
function extractText(json: unknown): string {
  const resp = (json as Record<string, unknown>)?.response as Record<string, unknown> | undefined;
  const lastMessage = resp?.lastMessage as Record<string, unknown> | undefined;
  const content = lastMessage?.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return JSON.stringify(json);
  return content
    .filter((block) => block.type === 'textBlock' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

/** /api/cognito-token からトークンとRuntime URLを取得 */
async function fetchTokenAndUrl(): Promise<{ accessToken: string; idToken?: string; runtimeUrl: string }> {
  const res = await fetch('/api/cognito-token?forceRefresh=true');
  if (!res.ok) throw new Error('認証情報の取得に失敗しました');
  const data = await res.json();
  if (!data.accessToken || !data.runtimeUrl) throw new Error('Runtime URLが設定されていません');
  return data;
}

/** 推論過程（thinking / tool use）の表示。最終回答が始まったらアコーディオンで折りたたむ */
function StepsDisplay({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;

  return (
    <details className="mb-2 group">
      <summary className="list-none cursor-pointer select-none">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 hover:text-muted-foreground/80 transition-colors">
          <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
          推論過程（{steps.length}ステップ）
        </span>
      </summary>
      <div className="space-y-1 mt-1">
        {steps.map((step, i) => (
          <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground/50 leading-relaxed">
            {step.type === 'thinking' ? (
              <>
                <Brain className="w-3 h-3 mt-0.5 shrink-0" />
                <span className="whitespace-pre-wrap break-words">{step.text}</span>
              </>
            ) : (
              <>
                <Wrench className="w-3 h-3 mt-0.5 shrink-0" />
                <span>{step.name.includes('___') ? step.name.split('___').pop() : step.name}</span>
              </>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

const MessageBubble = memo(function MessageBubble({
  message,
  isAnimating,
}: {
  message: Message;
  isAnimating: boolean;
}) {
  return (
    <div className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      {message.role === 'assistant' && (
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-4 h-4 text-primary" />
        </div>
      )}
      <div
        className={`max-w-[95%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          message.role === 'user'
            ? 'bg-primary text-primary-foreground rounded-tr-none'
            : 'bg-secondary text-secondary-foreground rounded-tl-none'
        }`}
      >
        {message.role === 'assistant' ? (
          message.content === '' && isAnimating && !message.steps?.length ? (
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce [animation-delay:0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-current opacity-40 animate-bounce [animation-delay:0.3s]" />
            </span>
          ) : (
            <>
              {message.steps && <StepsDisplay steps={message.steps} />}
              {message.fadingTexts?.map((ft) => (
                <div key={ft.id} className="animate-absorb">
                  <Streamdown animated={false} isAnimating={false} mode="streaming" rehypePlugins={rehypePlugins}>
                    {ft.text}
                  </Streamdown>
                </div>
              ))}
              <Streamdown animated isAnimating={isAnimating} mode="streaming" rehypePlugins={rehypePlugins}>
                {message.content}
              </Streamdown>
              {message.images && message.images.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.images.map((img, i) => (
                    <Dialog key={i}>
                      <DialogTrigger asChild>
                        <button className="relative group rounded-lg overflow-hidden border border-border/40 hover:border-primary/40 transition-colors">
                          {/* eslint-disable-next-line @next/next/no-img-element -- data URI画像にはnext/imageは不適 */}
                          <img
                            src={`data:${img.mimeType};base64,${img.data}`}
                            alt={`生成されたグラフ ${i + 1}`}
                            className="max-w-full max-h-64 object-contain"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                            <ZoomIn className="w-5 h-5 text-white opacity-0 group-hover:opacity-80 transition-opacity drop-shadow" />
                          </div>
                        </button>
                      </DialogTrigger>
                      <DialogContent className="max-w-[90vw] sm:max-w-[90vw] p-2">
                        <VisuallyHidden>
                          <DialogTitle>グラフ拡大表示</DialogTitle>
                        </VisuallyHidden>
                        {/* eslint-disable-next-line @next/next/no-img-element -- data URI画像にはnext/imageは不適 */}
                        <img
                          src={`data:${img.mimeType};base64,${img.data}`}
                          alt={`生成されたグラフ ${i + 1}`}
                          className="max-h-[85vh] object-contain"
                        />
                      </DialogContent>
                    </Dialog>
                  ))}
                </div>
              )}
            </>
          )
        ) : (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
      </div>
      {message.role === 'user' && (
        <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-4 h-4 text-primary-foreground" />
        </div>
      )}
    </div>
  );
});

const SUGGESTIONS = [
  '店舗別の売上トップ5を教えて',
  'ECサイトの顧客行動データを要約して',
  '営業担当者の成績評価レポートを作成して',
  'B2B商談パイプラインの状況を教えて',
  '緑茶セットってどのくらい売れてる？',
  '来月の売上を予測してグラフで見せて',
  '公開フォルダの製品カタログを要約して',
  '過去24時間にデータアクセスしたユーザーを一覧して',
  '過去24時間のアクセス拒否を検索して',
];

// rehype-harden の imageBlockPolicy を "remove" に変更し、sandbox: 等の画像URLが [Image blocked: ...] と表示されるのを防ぐ
const [hardenPlugin, hardenDefaults] = defaultRehypePlugins.harden as [unknown, Record<string, unknown>];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- streamdown内部のPluggable型に合わせるため
const rehypePlugins: any[] = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  [hardenPlugin, { ...hardenDefaults, imageBlockPolicy: 'remove' }],
];

export function ChatInterface({
  projectId,
  onScroll,
  sessionId: initialSessionId,
  onSessionStart,
  onTitleUpdate,
}: {
  projectId: string;
  onScroll?: (scrollTop: number) => void;
  sessionId?: string;
  onSessionStart?: (sessionId: string, title: string) => void;
  onTitleUpdate?: (sessionId: string, title: string) => void;
}) {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(!!initialSessionId);
  const [sessionId] = useState(() => initialSessionId || crypto.randomUUID());
  const hasStartedRef = useRef(!!initialSessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // 既存セッションの履歴をロード
  useEffect(() => {
    if (!initialSessionId) return;
    fetch(`/api/sessions/${initialSessionId}/events`)
      .then((res) => (res.ok ? res.json() : []))
      .then(
        (
          events: {
            role: string;
            content: { type: string; text?: string; base64?: string; format?: string; source?: { bytes?: string } }[];
          }[],
        ) => {
          const loaded: Message[] = [];
          for (const e of events) {
            const text = (e.content || [])
              .filter((b) => b.type === 'text' || b.type === 'textBlock')
              .map((b) => b.text || '')
              .join('');
            const images = (e.content || [])
              .filter((b) => b.type === 'imageBlock' && (b.base64 || b.source?.bytes))
              .map((b) => ({
                data: b.base64 || b.source?.bytes || '',
                mimeType: `image/${b.format || 'png'}`,
              }));
            if (text || images.length > 0) {
              loaded.push({
                id: crypto.randomUUID(),
                role: e.role as 'user' | 'assistant',
                content: text,
                images: images.length > 0 ? images : undefined,
              });
            }
          }
          setMessages(loaded);
        },
      )
      .catch((e) => console.error('Failed to load history:', e))
      .finally(() => setIsLoadingHistory(false));
  }, [initialSessionId]);

  const sendMessage = useCallback(
    async (text: string) => {
      // 新規チャットの最初の送信時にURL更新 + サイドバー楽観的更新
      if (!hasStartedRef.current) {
        hasStartedRef.current = true;
        onSessionStart?.(sessionId, text.length > 30 ? `${text.substring(0, 30)}...` : text);
      }
      const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text };
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [...prev, userMessage, { id: assistantId, role: 'assistant', content: '' }]);
      setIsStreaming(true);

      try {
        const { accessToken, idToken, runtimeUrl } = await fetchTokenAndUrl();

        const response = await fetch(runtimeUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
            ...(projectId && {
              'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Sagemaker-Project-Id': projectId,
            }),
            ...(idToken && {
              'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Cognito-Id-Token': idToken,
            }),
          },
          body: JSON.stringify({ prompt: text }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Runtime error: ${response.status} ${errorText}`);
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('text/event-stream')) {
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const imageEvent = parseImageEvent(data);
                if (imageEvent) {
                  flushSync(() => {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? {
                              ...m,
                              images: [...(m.images || []), { data: imageEvent.data, mimeType: imageEvent.mimeType }],
                            }
                          : m,
                      ),
                    );
                  });
                  requestAnimationFrame(() => {
                    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                  });
                  continue;
                }
                const parsed = JSON.parse(data);
                if (parsed && typeof parsed === 'object' && 'messages' in parsed) continue;
                if (parsed && typeof parsed === 'object' && 'type' in parsed) {
                  const evt = parsed as SSEEvent;
                  if (evt.type === 'thinking' && evt.text) {
                    flushSync(() => {
                      setMessages((prev) =>
                        prev.map((m) => {
                          if (m.id !== assistantId) return m;
                          const steps = [...(m.steps || [])];
                          const last = steps[steps.length - 1];
                          if (last?.type === 'thinking') {
                            steps[steps.length - 1] = { ...last, text: last.text + evt.text };
                          } else {
                            steps.push({ type: 'thinking', text: evt.text });
                          }
                          return { ...m, steps };
                        }),
                      );
                    });
                    continue;
                  }
                  if (evt.type === 'tool_start' && evt.name) {
                    flushSync(() => {
                      setMessages((prev) =>
                        prev.map((m) =>
                          m.id === assistantId
                            ? { ...m, steps: [...(m.steps || []), { type: 'tool' as const, name: evt.name }] }
                            : m,
                        ),
                      );
                    });
                    continue;
                  }
                  if (evt.type === 'stop') {
                    if (evt.stopReason === 'toolUse') {
                      // 中間テキスト → contentクリア＆fadingTextsに追加 → 800ms後にstepsに退避（ノンブロッキング）
                      const snapshot = messagesRef.current.find((m) => m.id === assistantId)?.content || '';
                      if (snapshot) {
                        const fadingId = Date.now();
                        flushSync(() => {
                          setMessages((prev) =>
                            prev.map((m) =>
                              m.id === assistantId
                                ? {
                                    ...m,
                                    content: '',
                                    fadingTexts: [...(m.fadingTexts || []), { id: fadingId, text: snapshot }],
                                  }
                                : m,
                            ),
                          );
                        });
                        setTimeout(() => {
                          setMessages((prev) =>
                            prev.map((m) => {
                              if (m.id !== assistantId) return m;
                              const target = m.fadingTexts?.find((ft) => ft.id === fadingId);
                              if (!target) return m;
                              return {
                                ...m,
                                fadingTexts: m.fadingTexts?.filter((ft) => ft.id !== fadingId),
                                steps: [...(m.steps || []), { type: 'thinking' as const, text: target.text }],
                              };
                            }),
                          );
                        }, 800);
                      }
                    } else if (evt.stopReason === 'endTurn') {
                      // 画像markdownの除去はrehype-hardenのimageBlockPolicy:"remove"で処理
                    }
                    continue;
                  }
                  if (evt.type === 'title_update' && evt.title) {
                    onTitleUpdate?.(sessionId, evt.title);
                    continue;
                  }
                  continue;
                }
                // テキストチャンク → contentにストリーミング表示
                const chunk = typeof parsed === 'string' ? parsed : extractText(parsed);
                if (chunk) {
                  flushSync(() => {
                    setMessages((prev) =>
                      prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
                    );
                  });
                  if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                }
              } catch {
                flushSync(() => {
                  setMessages((prev) =>
                    prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + data } : m)),
                  );
                });
              }
            }
          }
        } else {
          const json = await response.json();
          const finalText = extractText(json);
          setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: finalText } : m)));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content: `エラー: ${errorMessage}` } : m)),
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [sessionId, projectId, onSessionStart, onTitleUpdate],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    void sendMessage(input);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <ScrollArea
        ref={scrollRef}
        className="flex-1 min-h-0"
        onScrollCapture={(e) => onScroll?.((e.target as HTMLElement).scrollTop)}
      >
        <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
          {messages.length === 0 && !projectId && <ProjectRequiredPlaceholder />}
          {messages.length === 0 && projectId && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-lg font-medium text-foreground mb-1">Agentic Analyst</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                売上データの検索、アクセスログの分析など、データに関する質問をどうぞ
              </p>
              <div className="flex flex-wrap gap-2 mt-6 justify-center max-w-2xl">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => sendMessage(suggestion)}
                    className="px-3 py-1.5 text-xs rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-primary/5 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              isAnimating={isStreaming && message.id === messages[messages.length - 1]?.id}
            />
          ))}
        </div>
      </ScrollArea>

      <div className="border-t bg-background/80 backdrop-blur-sm">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto px-4 py-3">
          <div className="flex gap-2 items-end">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="メッセージを入力..."
              className="min-h-[44px] max-h-32 resize-none rounded-xl border-border/60 focus-visible:ring-primary/30"
              disabled={isStreaming || !projectId}
            />
            <Button
              type="submit"
              size="icon"
              disabled={isStreaming || isLoadingHistory || !input.trim() || !projectId}
              className="rounded-xl shrink-0 h-[44px] w-[44px]"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/60 mt-1 text-right">⌘+Enter または Ctrl+Enter で送信</p>
        </form>
      </div>
    </div>
  );
}
