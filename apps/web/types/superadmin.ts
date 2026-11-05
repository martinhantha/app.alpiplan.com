export type TenantRole = "ADMIN" | "STAFF" | "END_CUSTOMER";

export interface SuperadminTenant {
  id: string;
  name: string;
  slug: string;
  useDefaultDuration: boolean;
  speechRecognitionEnabled?: boolean;
  aiParsingEnabled?: boolean;
  createdAt: string;
}

export interface SuperadminUserMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: TenantRole;
}

export interface SuperadminUser {
  id: string;
  email: string;
  name: string | null;
  isSuperadmin: boolean;
  disabledAt: string | null;
  memberships: SuperadminUserMembership[];
}

export interface SuperadminOverview {
  tenants: SuperadminTenant[];
  users: SuperadminUser[];
}
