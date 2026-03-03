export interface EditionBundle {
  schema_version: string;
  generated_at: string;
  edition: {
    date: string;
    hebrew_date: string;
    hebrew_month: number;
    hebrew_year: number;
    holiday: string;
    publication: {
      name: string;
      language: string;
      place_of_publication: string;
    };
  };
  pages: Page[];
  content_units: ContentUnit[];
  events: Event[];
  people: Person[];
  locations: Location[];
  organizations: Organization[];
  topics: Topic[];
  sections: Section[];
  corrections?: Correction[];
}

export interface Page {
  id: string;
  page_number: number;
  image: {
    uri: string;
    width: number;
    height: number;
    format: string;
  };
  blocks: Block[];
}

export interface Block {
  id: string;
  bbox: [number, number, number, number];
  transcription: string;
  confidence: number;
  image_crop: string;
  content_unit_id: string;
}

export interface ContentUnit {
  id: string;
  type: string;
  title: string;
  category: string;
  full_text: string;
  english_translation?: string;
  page_blocks: { page_id: string; block_ids: string[] }[];
  [key: string]: any;
}

export interface Person {
  id: string;
  name: string;
  yiddish_name?: string;
  [key: string]: any;
}

export interface Event {
  id: string;
  name: string;
  [key: string]: any;
}

export interface Location {
  id: string;
  name: string;
  [key: string]: any;
}

export interface Organization {
  id: string;
  name: string;
  [key: string]: any;
}

export interface Topic {
  id: string;
  name: string;
  [key: string]: any;
}

export interface Section {
  id: string;
  label: string;
  [key: string]: any;
}

export type BlockStatus = 'pending' | 'done_no_error' | 'done_errors_found';

export interface Correction {
  path: string; // e.g., "pages.0.blocks.5.transcription"
  original: any;
  corrected: any;
  status: BlockStatus;
  comment?: string;
  timestamp: string;
}
