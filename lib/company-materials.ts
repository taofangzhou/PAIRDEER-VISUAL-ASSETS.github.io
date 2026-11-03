import materialDefaults from './company-materials-defaults.json' with { type: 'json' };

/** Public catalog metadata. Files and generated previews are served by this ECS. */
export type CompanyMaterialKind = 'ppt' | 'video';
export type CompanyMaterial = {
  url: string;
  name: string;
  size: number;
  updatedAt: string;
  previewUrl?: string;
};
export type CompanyMaterials = Partial<Record<CompanyMaterialKind, CompanyMaterial>>;
export const COMPANY_MATERIAL_MAX_BYTES = 250 * 1024 * 1024;
export const COMPANY_PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const defaultCompanyMaterials: CompanyMaterials = materialDefaults;

export function resolveCompanyMaterials(materials?: CompanyMaterials): CompanyMaterials {
  return { ...defaultCompanyMaterials, ...materials };
}

function materialUrl(value: unknown, kind: CompanyMaterialKind, preview = false) {
  if (typeof value !== 'string') return false;
  const extension = preview ? 'pdf' : kind === 'ppt' ? 'pptx' : 'mp4';
  return new RegExp('^/api/media/[a-z0-9-]+\\.' + extension + '$').test(value) ||
    value === (preview ? '/assets/company/company-introduction-preview.pdf' :
      kind === 'ppt' ? '/assets/company/company-introduction.pptx' : '/assets/company/company-introduction.mp4');
}

/** Restrict company references to the ECS, including uploaded preview PDFs. */
export function validateCompanyMaterials(value: unknown): asserts value is CompanyMaterials | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => key !== 'ppt' && key !== 'video')) throw new Error('公司介绍资料格式无效');
  for (const [key, raw] of Object.entries(value)) {
    const kind = key as CompanyMaterialKind;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('公司介绍文件信息无效');
    const asset = raw as CompanyMaterial;
    if (!materialUrl(asset.url, kind) || typeof asset.name !== 'string' || !asset.name.trim() ||
        asset.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(asset.name) ||
        !asset.name.toLowerCase().endsWith(kind === 'ppt' ? '.pptx' : '.mp4') ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > COMPANY_MATERIAL_MAX_BYTES ||
        typeof asset.updatedAt !== 'string' || !Number.isFinite(Date.parse(asset.updatedAt))) {
      throw new Error('公司介绍文件信息无效');
    }
    if (kind === 'ppt' && !materialUrl(asset.previewUrl, kind, true)) throw new Error('PPT 预览文件无效');
    if (kind === 'video' && asset.previewUrl !== undefined) throw new Error('视频预览信息无效');
  }
}
