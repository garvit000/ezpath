import { CommunityReport, ReportIssueType } from '../../types';
import { authService } from '../auth/cognito';

type FetchLike = typeof fetch;

interface UploadRequest {
  reportId: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

export interface ReportSubmission {
  reportId: string;
  status: 'PENDING_REVIEW';
  submittedAt: string;
}

export interface ReportDetails {
  description: string;
  locationId: string;
  issueType: ReportIssueType;
}

export class ReportsClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    const baseUrl = options.baseUrl ?? import.meta.env.VITE_API_BASE_URL;
    this.baseUrl = (baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  private async json<T>(path: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    if (!this.baseUrl) throw new Error('Community reports are not configured for this build.');
    const token = authenticated ? authService.getAccessToken() : null;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Report request failed with status ${response.status}.`);
    }
    return payload as T;
  }

  async submit(photo: Blob | null, details: ReportDetails): Promise<ReportSubmission> {
    if (!photo) {
      return this.json<ReportSubmission>('/v1/reports', { method: 'POST', body: JSON.stringify(details) });
    }
    const upload = await this.json<UploadRequest>('/v1/reports/upload-request', {
      method: 'POST',
      body: JSON.stringify({ contentType: photo.type, sizeBytes: photo.size }),
    });
    const uploadResponse = await this.fetchImpl(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': photo.type },
      body: photo,
    });
    if (!uploadResponse.ok) throw new Error('The evidence photo could not be uploaded. Please try again.');
    return this.json<ReportSubmission>('/v1/reports', {
      method: 'POST',
      body: JSON.stringify({ reportId: upload.reportId, ...details }),
    });
  }

  listPending(): Promise<CommunityReport[]> {
    return this.json<CommunityReport[]>('/v1/reports', { method: 'GET' }, true);
  }

  review(reportId: string, action: 'verify' | 'reject'): Promise<CommunityReport> {
    return this.json<CommunityReport>(
      `/v1/reports/${encodeURIComponent(reportId)}/${action}`,
      { method: 'POST' },
      true,
    );
  }
}

export const reportsClient = new ReportsClient();
