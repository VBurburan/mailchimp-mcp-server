// Mailchimp Marketing API v3 client

const API_KEY = process.env.MAILCHIMP_API_KEY || "";
const DATA_CENTER = API_KEY.split("-").pop() || "us1";
const BASE_URL = `https://${DATA_CENTER}.api.mailchimp.com/3.0`;

interface MailchimpRequestOptions {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

export async function mailchimpRequest<T>(options: MailchimpRequestOptions): Promise<T> {
  if (!API_KEY) {
    throw new Error("MAILCHIMP_API_KEY environment variable is not set. Format: <key>-<dc> (e.g., abc123-us14)");
  }

  const url = new URL(`${BASE_URL}${options.path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(url.toString(), {
    method: options.method,
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  // Some endpoints return 204 No Content (e.g., send campaign)
  if (response.status === 204) {
    return {} as T;
  }

  const data = await response.json();

  if (!response.ok) {
    const errorDetail = (data as Record<string, unknown>).detail || (data as Record<string, unknown>).title || "Unknown error";
    throw new Error(`Mailchimp API error (${response.status}): ${errorDetail}`);
  }

  return data as T;
}
