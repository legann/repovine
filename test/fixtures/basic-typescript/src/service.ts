import { formatDate } from './utils.js';
import type { User, Post } from './models.js';

export class UserService {
  private users: Map<string, User> = new Map();

  create(name: string, email: string): User {
    const user: User = {
      id: crypto.randomUUID(),
      name,
      email,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  getById(id: string): User | undefined {
    return this.users.get(id);
  }

  formatUserDate(user: User): string {
    return formatDate(user.createdAt);
  }
}

export function createPost(title: string, content: string, authorId: string): Post {
  return {
    id: crypto.randomUUID(),
    title,
    content,
    authorId,
  };
}
