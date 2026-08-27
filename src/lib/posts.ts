const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
});

export function formatPostDate(date: Date, style: "short" | "long" = "short") {
    return style === "long" ? longDateFormatter.format(date) : shortDateFormatter.format(date);
}

export function getReadingMinutes(body: string | undefined) {
    const wordCount = body?.trim().split(/\s+/).filter(Boolean).length ?? 0;
    return Math.max(1, Math.ceil(wordCount / 220));
}
