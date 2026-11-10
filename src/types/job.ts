export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  description: string;
  url: string;
  source: string;
  publishedAt?: string;
}
