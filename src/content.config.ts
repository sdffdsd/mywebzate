import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 内容层：Markdown 写正文，schema 管元数据。
 * 纯构建期校验 —— 写错字段会在 build 时报错，而不是上线后才发现。
 */
const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { notes };
