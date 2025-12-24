// Constants that can be safely imported on client and server

export const FLEET_MARQUE_MAKES = [
  { name: 'AUDI', slug: 'audi' },
  { name: 'BMW', slug: 'bmw' },
  { name: 'BYD', slug: 'byd' },
  { name: 'CHERY', slug: 'chery' },
  { name: 'CITROEN', slug: 'citroen' },
  { name: 'CUPRA', slug: 'cupra' },
  { name: 'DACIA', slug: 'dacia' },
  { name: 'DS', slug: 'ds' },
  { name: 'GEELY', slug: 'geely' },
  { name: 'GENESIS', slug: 'genesis' },
  { name: 'HONDA', slug: 'honda' },
  { name: 'HYUNDAI', slug: 'hyundai' },
  { name: 'JAECOO', slug: 'jaecoo' },
  { name: 'KIA', slug: 'kia' },
  { name: 'LAND ROVER', slug: 'land-rover' },
  { name: 'LEAPMOTOR', slug: 'leapmotor' },
  { name: 'LEXUS', slug: 'lexus' },
  { name: 'MAXUS', slug: 'maxus' },
  { name: 'MAZDA', slug: 'mazda' },
  { name: 'MG MOTOR UK', slug: 'mg-motor-uk' },
  { name: 'NISSAN', slug: 'nissan' },
  { name: 'OMODA', slug: 'omoda' },
  { name: 'PEUGEOT', slug: 'peugeot' },
  { name: 'PORSCHE', slug: 'porsche' },
  { name: 'RENAULT', slug: 'renault' },
  { name: 'SEAT', slug: 'seat' },
  { name: 'SKODA', slug: 'skoda' },
  { name: 'TOYOTA', slug: 'toyota' },
  { name: 'VAUXHALL', slug: 'vauxhall' },
  { name: 'VOLKSWAGEN', slug: 'volkswagen' },
  { name: 'VOLVO', slug: 'volvo' }
] as const;

export type FleetMarqueMake = typeof FLEET_MARQUE_MAKES[number];

export type ScraperConfig = {
  sid?: string;
  phpsessid?: string;
  email?: string;
  password?: string;
  minDelay?: number;
  maxDelay?: number;
  betweenMakes?: number;
};

export type ScrapeProgress = {
  currentMake: string;
  currentModel: string;
  makesCompleted: number;
  totalMakes: number;
  vehiclesFound: number;
  status: 'idle' | 'running' | 'completed' | 'error';
  error?: string;
};
