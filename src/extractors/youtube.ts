import { http_get, http_post } from "../http.ts";
import { NetworkError, ParseError } from "../errors.ts";
import type { MediaItem, MediaResult, ResolveOptions } from "../types.ts";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=";
const INNERTUBE_NEXT_URL = "https://www.youtube.com/youtubei/v1/next?key=";
const OEMBED_URL = "https://www.youtube.com/oembed";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

const ANDROID_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "21.02.35",
  androidSdkVersion: 30,
  hl: "en",
  gl: "US",
  userAgent: "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
};

const TV_CLIENT = {
  clientName: "TVHTML5",
  clientVersion: "7.20240101",
  hl: "en",
  gl: "US",
};

type YoutubePlayerResponse = {
  playabilityStatus?: { status: string; reason?: string };
  videoDetails?: {
    title: string;
    author: string;
    viewCount: string;
    shortDescription?: string;
    thumbnail?: {
      thumbnails: Array<{ url: string; width: number; height: number }>;
    };
  };
  streamingData?: {
    formats?: Array<YoutubeFormat>;
    adaptiveFormats?: Array<YoutubeFormat>;
  };
};

type YoutubeFormat = {
  url?: string;
  mimeType: string;
  width?: number;
  bitrate: number;
  audioChannels?: number;
};

type YoutubeOEmbedResponse = {
  title?: string;
  author_name?: string;
  author_url?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
};

function extract_video_id(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function sanitize_filename(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, "").trim();
}

function extract_innertube_key(html: string): string | null {
  const match = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  return match?.[1] || null;
}

function extract_publish_timestamp(html: string): number | undefined {
  const match = html.match(/"publishDate":"([^"]+)"/);
  if (!match?.[1]) return undefined;
  const ts = Math.floor(new Date(match[1]).getTime() / 1000);
  return Number.isFinite(ts) ? ts : undefined;
}

function deep_find(obj: unknown, key: string): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === key) return v;
    const found = deep_find(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parse_abbreviated_number(text: string): number | undefined {
  const m = text.trim().match(/^([\d.]+)\s*([KkMmBb]?)$/);
  if (!m) return undefined;
  const multipliers: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
  return Math.round(parseFloat(m[1]) * (multipliers[m[2].toLowerCase()] ?? 1));
}

async function fetch_oembed(
  url: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<YoutubeOEmbedResponse | null> {
  try {
    const oembedUrl = new URL(OEMBED_URL);
    oembedUrl.searchParams.set("url", url);
    oembedUrl.searchParams.set("format", "json");

    const response = await http_get(oembedUrl.toString(), {
      headers,
      timeout,
    });

    return (await response.json()) as YoutubeOEmbedResponse;
  } catch {
    return null;
  }
}

function select_urls(
  data: YoutubePlayerResponse,
  video_id: string,
): MediaItem[] {
  if (data.playabilityStatus?.status !== "OK") {
    throw new ParseError(
      data.playabilityStatus?.reason || "Video not playable",
      "youtube",
    );
  }

  if (!data.streamingData) {
    throw new ParseError("No streaming data available", "youtube");
  }

  const formats = [
    ...(data.streamingData.formats || []),
    ...(data.streamingData.adaptiveFormats || []),
  ];

  const urls: MediaItem[] = [];

  const combined = formats
    .filter(
      (f) =>
        f.url &&
        f.audioChannels &&
        f.audioChannels > 0 &&
        f.width &&
        f.width > 0,
    )
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0];

  if (combined?.url) {
    urls.push({
      type: "video",
      url: combined.url,
      filename: `youtube-${video_id}.mp4`,
    });
  }

  const video_only = formats
    .filter(
      (f) =>
        f.url &&
        f.width &&
        f.width > 0 &&
        (!f.audioChannels || f.audioChannels === 0) &&
        f.mimeType.includes("video/mp4"),
    )
    .sort((a, b) => (b.width || 0) - (a.width || 0))[0];

  const audio_only = formats
    .filter(
      (f) =>
        f.url &&
        f.audioChannels &&
        f.audioChannels > 0 &&
        (!f.width || f.width === 0) &&
        f.mimeType.includes("audio/mp4"),
    )
    .sort((a, b) => b.bitrate - a.bitrate)[0];

  if (
    video_only?.url &&
    video_only.width &&
    video_only.width > (combined?.width || 0)
  ) {
    const ext = video_only.mimeType.includes("webm") ? "webm" : "mp4";
    urls.push({
      type: "video",
      url: video_only.url,
      filename: `youtube-${video_id}-video.${ext}`,
    });

    if (audio_only?.url) {
      urls.push({
        type: "audio",
        url: audio_only.url,
        filename: `youtube-${video_id}-audio.m4a`,
      });
    }
  }

  if (urls.length === 0) {
    throw new ParseError("No downloadable formats found", "youtube");
  }

  return urls;
}

export default async function resolve(
  url: string,
  options: ResolveOptions,
): Promise<MediaResult> {
  const video_id = extract_video_id(url);
  if (!video_id) {
    throw new ParseError("Could not extract video ID from URL", "youtube");
  }

  const timeout = options.timeout ?? 15_000;
  const request_headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": BROWSER_USER_AGENT,
    Cookie: "CONSENT=YES+1",
    ...options.headers,
  };

  try {

    const page = await http_get(`https://www.youtube.com/watch?v=${video_id}`, {
      headers: request_headers,
      timeout,
    });

    const html = await page.text();
    const api_key = extract_innertube_key(html);

    if (!api_key) {
      throw new ParseError("Could not find Innertube API key", "youtube");
    }

    const [innertube_response, next_response] = await Promise.all([
      http_post(
        `${INNERTUBE_PLAYER_URL}${api_key}`,
        JSON.stringify({
          videoId: video_id,
          context: { client: ANDROID_CLIENT },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        {
          headers: {
            ...request_headers,
            "Content-Type": "application/json",
            "User-Agent": ANDROID_CLIENT.userAgent,
            "X-Youtube-Client-Name": "3",
            "X-Youtube-Client-Version": ANDROID_CLIENT.clientVersion,
          },
          timeout,
        },
      ),
      http_post(
        `${INNERTUBE_NEXT_URL}${api_key}`,
        JSON.stringify({
          videoId: video_id,
          context: { client: TV_CLIENT },
        }),
        {
          headers: {
            ...request_headers,
            "Content-Type": "application/json",
            "X-Youtube-Client-Name": "7",
            "X-Youtube-Client-Version": TV_CLIENT.clientVersion,
          },
          timeout,
        },
      ).catch(() => null),
    ]);

    const data = (await innertube_response.json()) as YoutubePlayerResponse;
    const next_data = next_response ? await next_response.json() : null;

    const urls = select_urls(data, video_id);

    const title = data.videoDetails?.title || "YouTube video";
    const author = data.videoDetails?.author || "Unknown";
    const views = data.videoDetails?.viewCount
      ? Number.parseInt(data.videoDetails.viewCount, 10)
      : undefined;

    const thumbnails = data.videoDetails?.thumbnail?.thumbnails;
    const thumbnail_url = thumbnails?.length
      ? thumbnails[thumbnails.length - 1].url
      : undefined;

    const meta: MediaResult["meta"] = {
      title: sanitize_filename(title),
      author,
      platform: "youtube",
    };
    if (data.videoDetails?.shortDescription) {
      meta.description = data.videoDetails.shortDescription;
    }
    if (thumbnail_url) {
      meta.thumbnail = thumbnail_url;
    }
    if (views !== undefined && Number.isFinite(views)) {
      meta.views = views;
    }
    const publish_ts = extract_publish_timestamp(html);
    if (publish_ts !== undefined) {
      meta.timestamp = publish_ts;
    }
    if (next_data) {
      const likes = deep_find(next_data, "likeCount");
      if (typeof likes === "number" && Number.isFinite(likes)) {
        meta.likes = likes;
      }
      const comment_count_raw = deep_find(next_data, "commentCount");
      if (typeof comment_count_raw === "object" && comment_count_raw !== null) {
        const text = (comment_count_raw as { simpleText?: string }).simpleText;
        if (text) {
          const parsed = parse_abbreviated_number(text);
          if (parsed !== undefined) meta.comments = parsed;
        }
      }
    }

    return {
      urls,
      headers: {},
      meta,
    };
  } catch (e: any) {
    const oembed = await fetch_oembed(url, request_headers, timeout);
    if (oembed) {
      const meta: MediaResult["meta"] = {
        title: oembed.title || "YouTube video",
        author: oembed.author_name || "Unknown",
        platform: "youtube",
        description: oembed.title,
        thumbnail: oembed.thumbnail_url,
      };

      const urls: MediaItem[] = oembed.thumbnail_url
        ? [{ type: "image", url: oembed.thumbnail_url, filename: `youtube-${video_id}.jpg` }]
        : [];

      return {
        urls,
        headers: {},
        meta,
      };
    }

    if (e instanceof NetworkError || e instanceof ParseError) throw e;
    throw new ParseError(e.message, "youtube");
  }
}
