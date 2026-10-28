// ECS has an independently configured administrator; platform account claiming is retired.
export async function POST() {
 return Response.json({error:'管理员请使用本站管理员密码登录，无需激活外部账号。'},{status:410,headers:{'Cache-Control':'no-store'}});
}
