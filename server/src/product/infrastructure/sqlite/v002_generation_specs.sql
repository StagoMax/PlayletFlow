ALTER TABLE generation_jobs ADD COLUMN generation_spec_json TEXT NOT NULL
    DEFAULT '{"model":"doubao-seedream-5-0-260128","input":{"type":"textOnly"},"imageSize":"2K","videoResolution":null,"videoRatio":null,"durationSeconds":null,"generateAudio":null}';

UPDATE generation_jobs
SET generation_spec_json = CASE
    WHEN target_type = 'mediaPrompt' AND EXISTS (
        SELECT 1 FROM media_items media
        WHERE media.id = generation_jobs.target_id AND media.kind = 'video'
    ) THEN '{"model":"doubao-seedance-2-0-mini-260615","input":{"type":"textOnly"},"imageSize":null,"videoResolution":"480p","videoRatio":"16:9","durationSeconds":4,"generateAudio":false}'
    ELSE '{"model":"doubao-seedream-5-0-260128","input":{"type":"textOnly"},"imageSize":"2K","videoResolution":null,"videoRatio":null,"durationSeconds":null,"generateAudio":null}'
END
;
