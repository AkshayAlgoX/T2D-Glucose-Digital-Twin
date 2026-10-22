import catalog from '@/data/indian-meals.json';

/**
 * Dishes of Indian origin from USDA FNDDS (public domain), built by scripts/build_indian_meals.py.
 * The scenario engine takes carbohydrate grams only, so a plate is reduced to its carbohydrate total;
 * fat, protein and fibre are not modelled and the UI says so.
 */
export interface MealPortion { label: string; grams: number }
export interface MealFood { fdcId: number; name: string; carbsPer100g: number; portions: MealPortion[]; category: string | null }
export interface PlateItem { food: MealFood; portion: MealPortion; count: number }

export const MEAL_SOURCE = { source: catalog.source, release: catalog.release, license: catalog.license, url: catalog.url, note: catalog.note };
export const MEAL_FOODS: ReadonlyArray<MealFood> = catalog.foods;

/** Case-insensitive match on every word of the query, so "dosa fill" finds "Dosa, with filling". */
export function searchFoods(query: string, foods: ReadonlyArray<MealFood> = MEAL_FOODS): MealFood[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  return foods.filter(f => words.every(w => f.name.toLowerCase().includes(w)));
}

export const itemCarbs = (item: PlateItem) => (item.food.carbsPer100g * item.portion.grams * item.count) / 100;

/** Plate carbohydrate in grams, to one decimal, as the scenario input expects. */
export function plateCarbs(plate: ReadonlyArray<PlateItem>): number {
  return Math.round(plate.reduce((sum, item) => sum + itemCarbs(item), 0) * 10) / 10;
}

export function describePlate(plate: ReadonlyArray<PlateItem>): string {
  return plate.map(i => `${i.count} × ${i.food.name} (${i.portion.label})`).join(' + ');
}
