# Generated by Django 2.2.3 on 2019-07-19 10:52

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [("motions", "0028_subcategories")]

    operations = [
        migrations.AddField(
            model_name="motioncommentsection",
            name="weight",
            field=models.IntegerField(default=10000),
        )
    ]