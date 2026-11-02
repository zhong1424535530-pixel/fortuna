import { Layers3 } from 'lucide-react'
import Select from './Select'
import type { AssetAccountGroup } from '../data/portfolio'

export default function AssetAccountFilter({ groups, value, onChange }: { groups: AssetAccountGroup[]; value: string; onChange: (id: string) => void }) {
  return <Select label="筛选账户" value={value} onChange={onChange} compact searchable options={[{ value: '全部', label: '全部账户', icon: <Layers3 size={18} /> }, ...groups.map(group => ({ value: group.id, label: group.name, icon: group.icon }))]} />
}
