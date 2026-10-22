import React, { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { MEAL_SOURCE, describePlate, itemCarbs, plateCarbs, searchFoods, type MealFood, type PlateItem } from '@/lib/meals';

/** Builds a plate from catalogued dishes and hands its carbohydrate total to the scenario form. */
export function MealBuilder({ disabled, onUse }: { disabled?: boolean; onUse: (carbs: number, description: string) => void }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [food, setFood] = useState<MealFood | null>(null);
  const [portion, setPortion] = useState(0);
  const [count, setCount] = useState('1');
  const [plate, setPlate] = useState<PlateItem[]>([]);
  const matches = query.trim() ? searchFoods(query).slice(0, 8) : [];
  const n = Number(count);
  const countOk = Number.isInteger(n) && n >= 1 && n <= 10;
  const total = plateCarbs(plate);

  const choose = (f: MealFood) => { setFood(f); setPortion(0); setQuery(''); };
  const add = () => {
    if (!food || !countOk || !food.portions[portion]) return;
    setPlate(p => [...p, { food, portion: food.portions[portion], count: n }]);
    setFood(null); setCount('1');
  };

  return (
    <details className="meal-builder" data-testid="meal-builder">
      <summary>Build the meal from Indian dishes <small>{MEAL_SOURCE.license} · USDA FNDDS</small></summary>
      <div className="meal-builder-body">
        <label htmlFor={`${id}-q`}>Find a dish</label>
        <input id={`${id}-q`} type="search" value={query} disabled={disabled} placeholder="idli, dal, roti, biryani…"
          autoComplete="off" onChange={e => setQuery(e.target.value)} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="fine-print">{searchHint(query, matches.length)}</p>
        {matches.length > 0 && <ul className="meal-matches" aria-label="Matching dishes">
          {matches.map(f => <li key={f.fdcId}><button type="button" className="meal-match" onClick={() => choose(f)} disabled={disabled}>
            {f.name}<small>{f.carbsPer100g} g carbohydrate / 100 g</small></button></li>)}
        </ul>}
        {food && <div className="meal-pick" role="group" aria-label={`Portion of ${food.name}`}>
          <strong>{food.name}</strong>
          <label>Portion
            <select value={portion} disabled={disabled} onChange={e => setPortion(Number(e.target.value))}>
              {food.portions.map((p, i) => <option key={p.label} value={i}>{p.label} · {p.grams} g</option>)}
            </select>
          </label>
          <label>Count
            <input type="number" min={1} max={10} step={1} value={count} disabled={disabled} onChange={e => setCount(e.target.value)} />
          </label>
          <button type="button" className="secondary-button" onClick={add} disabled={disabled || !countOk}><Plus size={14} aria-hidden="true" />Add to plate</button>
          {!countOk && <span role="alert" className="whatif-invalid">Count must be a whole number from 1 to 10</span>}
        </div>}
        {plate.length > 0 && <>
          <table className="meal-plate">
            <caption className="sr-only">Plate contents and carbohydrate per item</caption>
            <thead><tr><th scope="col">Dish</th><th scope="col">Portion</th><th scope="col" className="numeric">Carbohydrate</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
            <tbody>{plate.map((item, i) => <tr key={i}>
              <th scope="row">{item.food.name}<small> FDC {item.food.fdcId}</small></th>
              <td>{item.count} × {item.portion.label} ({item.portion.grams} g)</td>
              <td className="numeric">{itemCarbs(item).toFixed(1)} g</td>
              <td><button type="button" className="meal-remove" aria-label={`Remove ${item.food.name}`} onClick={() => setPlate(p => p.filter((_, j) => j !== i))}><X size={14} aria-hidden="true" /></button></td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row" colSpan={2}>Plate total</th><td className="numeric" data-testid="plate-total">{total.toFixed(1)} g</td><td /></tr></tfoot>
          </table>
          {total > 250 && <p role="alert" className="whatif-invalid">The scenario accepts at most 250 g of carbohydrate; remove an item.</p>}
          <button type="button" className="primary-button" disabled={disabled || total > 250 || total <= 0} onClick={() => onUse(total, describePlate(plate))}>Use {total.toFixed(1)} g carbohydrate</button>
        </>}
        <p className="fine-print meal-source">Carbohydrate per 100 g and portion weights: <a href={MEAL_SOURCE.url} target="_blank" rel="noreferrer">{MEAL_SOURCE.source}</a>, release {MEAL_SOURCE.release}. {MEAL_SOURCE.note} The twin uses carbohydrate grams only; fat, protein and fibre, which slow absorption, are not modelled.</p>
      </div>
    </details>
  );
}

function searchHint(query: string, found: number) {
  if (!query.trim()) return `${MEAL_SOURCE_COUNT} dishes catalogued.`;
  return found ? `${found} match${found === 1 ? '' : 'es'}.` : 'No catalogued dish matches. Enter carbohydrate grams directly instead.';
}
const MEAL_SOURCE_COUNT = searchFoods('').length;
