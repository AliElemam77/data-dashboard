-- ============================================================
-- Sales Dashboard — Supabase schema for cross-device sync
-- ============================================================
-- حل مشكلة عدم حفظ اليوزرز في قاعدة البيانات ومزامنة جميع الأجهزة:
-- 1. افتح Supabase Dashboard (https://supabase.com/dashboard)
-- 2. ادخل على مشروعك > SQL Editor من القائمة الجانبية
-- 3. انقر على New Query
-- 4. انسخ هذا الكود بالكامل والصقه هناك ثم انقر على Run
-- 5. اعمل Reload للداشبورد على اللاب توب والموبايل
-- ============================================================

-- 1. الجداول العامة (profiles, users, leads, asg, audit)
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

-- 2. جدول مشاريع التنفيذ (clients)
CREATE TABLE IF NOT EXISTS public.clients (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  cat TEXT DEFAULT '',
  city TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  wa TEXT DEFAULT '',
  site TEXT DEFAULT '',
  ig TEXT DEFAULT '',
  plat TEXT DEFAULT '',
  by TEXT DEFAULT '',
  at BIGINT DEFAULT 0,
  portal_active BOOLEAN DEFAULT true,
  portal_username TEXT DEFAULT '',
  portal_password TEXT DEFAULT '',
  seo INT DEFAULT 0,
  media INT DEFAULT 0,
  social INT DEFAULT 0,
  dev INT DEFAULT 0,
  ui INT DEFAULT 0,
  dept_details JSONB DEFAULT '{}'::jsonb,
  client_note TEXT DEFAULT '',
  expected_delivery TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. تفعيل أمان الصفوف (Row Level Security)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asg ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- 4. إعداد سياسات الوصول الشاملة للداشبورد
DROP POLICY IF EXISTS "open all" ON public.profiles;
DROP POLICY IF EXISTS "open all" ON public.users;
DROP POLICY IF EXISTS "open all" ON public.leads;
DROP POLICY IF EXISTS "open all" ON public.asg;
DROP POLICY IF EXISTS "open all" ON public.audit;
DROP POLICY IF EXISTS "open all" ON public.clients;

CREATE POLICY "open all" ON public.profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.leads FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.asg FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.audit FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "open all" ON public.clients FOR ALL USING (true) WITH CHECK (true);

-- 5. إعطاء صلاحيات القراءة والكتابة والتعديل والحذف للـ anon و authenticated
GRANT ALL ON TABLE public.profiles TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.users TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.leads TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.asg TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.audit TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.clients TO anon, authenticated, service_role;

-- 6. تفعيل التحديث اللحظي (Realtime) لجميع الجداول
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
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clients;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
