export const signInPages: Record<string, string>;
export const SIGN_IN_PASSWORD: string;
export const BASIC_AUTH: { realm: string; username: string; password: string };
export interface SignInPost {
  path: string;
  username: string;
  password: string;
}
export interface SignInSite {
  origin: string;
  altOrigin: string;
  posts: SignInPost[];
  close(): Promise<void>;
}
export function startSignInSite(): Promise<SignInSite>;
