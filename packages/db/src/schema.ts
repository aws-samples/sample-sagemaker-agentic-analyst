import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('userId').notNull(),
    sessionId: text('sessionId').notNull().unique(),
    title: text('title').notNull(),
    agentId: text('agentId'),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow().notNull(),
    // Drizzle ORM 経由の更新のみ反映（DB トリガーではない。DSQL はトリガー未サポート）
    updatedAt: timestamp('updatedAt', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('sessions_userId_updatedAt_idx').on(table.userId, table.updatedAt)],
);
