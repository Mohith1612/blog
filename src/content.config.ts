import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const posts = defineCollection({
	loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		tags: z.array(z.string()).default([]),
		image: z.string().optional(),
		imageAlt: z.string().optional(),
		imageWidth: z.number().int().positive().optional(),
		imageHeight: z.number().int().positive().optional(),
		series: z.object({
			name: z.string(),
			order: z.number().int().positive(),
		}).optional(),
	}),
});

export const collections = { posts };
