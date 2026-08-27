import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

function escapeXml(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}

export const GET: APIRoute = async ({ site }) => {
    const baseUrl = site ?? new URL("https://blog.mohith16.com");
    const posts = (await getCollection("posts"))
        .filter((post) => post.id !== "about")
        .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

    const items = posts.map((post) => {
        const url = new URL(`/posts/${post.id}/`, baseUrl).href;
        return `
        <item>
            <title>${escapeXml(post.data.title)}</title>
            <link>${url}</link>
            <guid isPermaLink="true">${url}</guid>
            <description>${escapeXml(post.data.description)}</description>
            <pubDate>${post.data.date.toUTCString()}</pubDate>
        </item>`;
    }).join("");

    const body = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
        <title>Dev Notes</title>
        <link>${baseUrl.href}</link>
        <description>Technical deep dives on backend systems, infrastructure, and performance.</description>
        <language>en</language>${items}
    </channel>
</rss>`;

    return new Response(body, {
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
    });
};
