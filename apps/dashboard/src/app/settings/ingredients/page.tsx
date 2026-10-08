import { IngredientManager } from '@/components/IngredientManager';
import { SettingsNav } from '@/components/SettingsNav';
import { Shell } from '@/components/Shell';
import { api, authed, type Ingredient, type Me, type MenuRow, type Recipes } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function IngredientsPage() {
  const me = await authed(() => api<Me>('/v1/me'));
  if (me.role !== 'OWNER' && me.role !== 'OPS') return <Shell me={me}><div className="empty">Hanya owner atau ops yang dapat mengelola bahan dan resep.</div></Shell>;
  const [ingredients, menu, recipes] = await authed(() => Promise.all([api<Ingredient[]>('/v1/ingredients'), api<MenuRow[]>('/v1/menu'), api<Recipes>('/v1/recipes')]));
  return (
    <Shell me={me}>
      <h1>Pengaturan</h1>
      <SettingsNav active="ingredients" role={me.role} />
      <IngredientManager ingredients={ingredients} menu={menu} recipes={recipes} />
    </Shell>
  );
}
