import type { UserSession } from "../types.js";

export class SessionStore {
  private readonly map = new Map<number, UserSession>();

  get(userId: number): UserSession {
    let session = this.map.get(userId);
    if (!session) {
      session = { userId };
      this.map.set(userId, session);
    }
    return session;
  }

  patch(userId: number, patch: Partial<UserSession>): UserSession {
    const session = this.get(userId);
    Object.assign(session, patch);
    return session;
  }

  reset(userId: number): void {
    this.map.set(userId, { userId });
  }
}
