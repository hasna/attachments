const FRIENDLY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRIENDLY_SLUG_MIN_LENGTH = 3;
const FRIENDLY_SLUG_MAX_LENGTH = 64;
const RESERVED_FRIENDLY_SLUGS = new Set(["__attachments_probe__"]);

export class FriendlySlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FriendlySlugError";
  }
}

export function parseFriendlySlug(input: string): string {
  const slug = input.trim();
  if (slug.length < FRIENDLY_SLUG_MIN_LENGTH || slug.length > FRIENDLY_SLUG_MAX_LENGTH) {
    throw new FriendlySlugError(
      `Friendly slug must be between ${FRIENDLY_SLUG_MIN_LENGTH} and ${FRIENDLY_SLUG_MAX_LENGTH} characters.`,
    );
  }
  if (!FRIENDLY_SLUG_PATTERN.test(slug)) {
    throw new FriendlySlugError(
      "Friendly slug must contain only lowercase letters, numbers, and single hyphens.",
    );
  }
  if (RESERVED_FRIENDLY_SLUGS.has(slug)) {
    throw new FriendlySlugError(`Friendly slug is reserved: ${slug}`);
  }
  return slug;
}

export function requireFriendlySlugPassword(slug: string | undefined, password: string | undefined): void {
  if (slug && !password) {
    throw new FriendlySlugError("Friendly links require a password because their URLs are guessable.");
  }
}
