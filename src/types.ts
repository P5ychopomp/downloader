export type ResolveOptions = {
  timeout?: number;
  headers?: Record<string, string>;
};

export type MediaItem = {
  type: "image" | "video" | "audio";
  url: string;
  filename: string;
};

export type MediaResult = {
  urls: MediaItem[];
  headers: Record<string, string>;
  meta: {
    title: string;
    author: string;
    platform: string;
    description?: string;
    thumbnail?: string;
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    timestamp?: number;
    reposts?: number;
    quoteTweet?: {
      tweetID: string;
      text: string;
      author: string;
      screenName: string;
    };
  };
};
