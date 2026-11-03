import materialDefaults from './company-materials-defaults.json' with { type: 'json' };

/** Original company PDF and video files are served directly by this ECS. */
export type CompanyMaterialKind = 'pdf' | 'video';
export type CompanyMaterial = {
  url: string;
  name: string;
  size: number;
  updatedAt: string;
};
export type CompanyMaterials = Partial<Record<CompanyMaterialKind, CompanyMaterial>>;
export const COMPANY_MATERIAL_MAX_BYTES = 250 * 1024 * 1024;
export const COMPANY_PDF_TYPE = 'application/pdf';
export const defaultCompanyMaterials: CompanyMaterials = materialDefaults;

function materialUrl(value: unknown, kind: CompanyMaterialKind) {
  if (typeof value !== 'string') return false;
  const extension = kind === 'pdf' ? 'pdf' : 'mp4';
  return new RegExp('^/api/media/[a-z0-9-]+\\.' + extension + '$').test(value) ||
    value === '/assets/company/company-introduction.' + extension;
}

function validMaterial(value: unknown, kind: CompanyMaterialKind): value is CompanyMaterial {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const asset = value as CompanyMaterial & { previewUrl?: unknown };
  return materialUrl(asset.url, kind) && typeof asset.name === 'string' && !!asset.name.trim() &&
    asset.name.length <= 255 && !/[\\/\x00-\x1f\x7f]/.test(asset.name) &&
    asset.name.toLowerCase().endsWith(kind === 'pdf' ? '.pdf' : '.mp4') &&
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= COMPANY_MATERIAL_MAX_BYTES &&
    typeof asset.updatedAt === 'string' && Number.isFinite(Date.parse(asset.updatedAt)) &&
    asset.previewUrl === undefined;
}

/** Ignore the former PPTX entry; keep valid PDF/video updates from existing ECS databases. */
export function resolveCompanyMaterials(value?: unknown): CompanyMaterials {
  const materials: CompanyMaterials = { ...defaultCompanyMaterials };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const saved = value as Record<string, unknown>;
    for (const kind of ['pdf', 'video'] as const) {
      const asset = saved[kind];
      if (validMaterial(asset, kind)) materials[kind] = {
        url: asset.url, name: asset.name, size: asset.size, updatedAt: asset.updatedAt,
      };
    }
  }
  return materials;
}

/** Restrict active company references to this ECS; legacy PPTX metadata is ignored. */
export function validateCompanyMaterials(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'pdf' && key !== 'video' && key !== 'ppt')) {
    throw new Error('公司介绍资料格式无效');
  }
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'ppt') continue;
    if (!validMaterial(raw, key as CompanyMaterialKind)) throw new Error('公司介绍文件信息无效');
  }
}
