-- ============================================================
-- Sales Dashboard — Supabase schema for cross-device sync
-- المشكلة: جدول clients فقط كان موجود، فاليوزر اللي بيتعمل
-- من الموبايل كان بيتحفظ في localStorage بتاع الموبايل بس
-- ومش بيظهر على اللاب.
-- الحل: جداول سحابية لكل الكولكشنز + Realtime.
--
-- طريقة التشغيل (مرة واحدة فقط):
-- 1. افتح Supabase Dashboard > SQL Editor > New query
-- 2. الصق الملف ده كله ودوس Run
-- 3. اعمل Reload للداشبورد على الموبايل واللاب
-- ============================================================

-- ---------- generic helper: id + data jsonb ----------
CREATE TABLE IF NOT EXISTS public.profiles (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leads (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.asg (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ---------- RLS: نفس سياسة جدول clients (مفتوح للـ anon) ----------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asg ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "open all" ON public.profiles;
DROP POLICY IF EXISTS "open all" ON public.users;
DROP POLICY IF EXISTS "open all" ON public.leads;
DROP POLICY IF EXISTS "open all" ON public.asg;
DROP POLICY IF EXISTS "open all" ON public.audit;

CREATE POLICY "open all" ON public.profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.asg FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.audit FOR ALL USING (true) WITH CHECK (true);

-- ---------- Realtime (عشان الجهاز التاني يشوف التغيير لحظياً) ----------
-- لو الجدول مضاف قبل كده السطر ده هيطلع warning وده طبيعي.
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.leads;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.asg;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.audit;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
