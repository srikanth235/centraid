-- A tag's chosen palette hue is shared by every entity wearing that label.
ALTER TABLE concept ADD COLUMN color TEXT CHECK (color IS NULL OR (kind = 'tag' AND color IN ('listBlue','listYellow','listViolet','listPetrol','listNavy','listGraphite','listRaspberry','listOrchid')));
