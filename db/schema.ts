import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const catalog = sqliteTable('catalog',{id:integer('id').primaryKey(),data:text('data').notNull(),revision:integer('revision').notNull().default(1)});
export const admin = sqliteTable('admin',{id:integer('id').primaryKey(),userId:text('user_id').notNull()});
export const favorites = sqliteTable('favorites',{userId:text('user_id').primaryKey(),data:text('data').notNull()});
